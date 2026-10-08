import "../instrumentation.js";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { startActiveObservation, getActiveTraceId } from "@langfuse/tracing";

import { langfuse } from "../langfuse.js";
import { fetchPrompt } from "../notice.js";
import { CHECK_NAMES } from "../domain/compliance.js";
import { DEFAULT_MODEL } from "../llm.js";
import { scoreVersion, printComparison } from "./experiment.js";
import {
  PROMPT_NAME,
  PRODUCTION_LABEL,
  CANDIDATE_LABEL,
  LANGFUSE_BASE_URL,
  MOCK_LLM,
  TRACING_ENVIRONMENT,
} from "../env.js";
import {
  main,
  parseArgs,
  heading,
  table,
  scoreColor,
  bold,
  dim,
  green,
  red,
  yellow,
  blue,
  magenta,
} from "./_shared.js";

/**
 * Act 4 — the agent proposes, the gate judges, a human decides.
 *
 * This is the part that makes "control plane" more than a slogan. The agent
 * uses exactly the same four surfaces a human engineer uses, through the same
 * API:
 *
 *   1. READ production signal  — scores on real traces, grouped by failing check
 *   2. READ the current prompt — text and config of the live version
 *   3. WRITE a new version     — labelled `candidate`, with a commit message
 *      explaining its reasoning, so the change is reviewable
 *   4. RUN the same gate       — the identical dataset and evaluators a human run uses
 *
 * And then it stops. It cannot move the `production` label, because promotion
 * is a human decision with an audit trail. That boundary is the design: agents
 * get write access to proposals, humans keep write access to production.
 */

const PROPOSER_MODEL = DEFAULT_MODEL;

const ProposedPrompt = z.object({
  system_message: z
    .string()
    .describe(
      "The full replacement system message. Keep every {{variable}} placeholder that the " +
        "current version uses, spelled identically.",
    ),
  user_message: z
    .string()
    .describe(
      "The full replacement user message. Keep every {{variable}} placeholder, spelled identically.",
    ),
  commit_message: z
    .string()
    .describe(
      "One or two sentences for the audit trail: what changed and which failing check it targets. " +
        "Written for a compliance reviewer, not an engineer.",
    ),
  reasoning: z
    .string()
    .describe("Short explanation of the diagnosis behind the change."),
});

interface WeakSpot {
  check: string;
  mean: number;
  samples: number;
  exampleComment: string | undefined;
}

/**
 * Step 1 — read production signal out of Langfuse.
 *
 * Scores written by the runtime guardrails are the agent's input. This is why
 * linking prompts to traces matters: without it there is no way to attribute a
 * weak check to the version that caused it.
 */
async function readWeakSpots(lookbackHours: number): Promise<WeakSpot[]> {
  const from = new Date(Date.now() - lookbackHours * 3600_000).toISOString();

  // Page through rather than taking the first 100. A single capped page is an
  // arbitrary slice of recent traffic, and a diagnosis built on an arbitrary
  // slice is worse than no diagnosis — it is a confident wrong one.
  const scores: Array<{ name: string; value: unknown; comment?: string | null }> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const response = await langfuse.api.scoresV3.getManyV3({
      dataType: "NUMERIC",
      fromTimestamp: from,
      limit: 100,
      cursor,
      fields: "details",
      // Only this app's traffic. The SDK tags experiment runs `sdk-experiment`,
      // so without this filter the agent would read its own eval scores back as
      // if they were production signal.
      environment: TRACING_ENVIRONMENT,
    });
    scores.push(...(response.data as typeof scores));
    cursor = response.meta?.cursor ?? undefined;
    if (!cursor) break;
  }

  /**
   * Only this app's own checks count as signal.
   *
   * Allowlist rather than denylist, and that distinction was earned: a shared
   * Langfuse project also held a second application's scores plus the run-level
   * aggregates (`compliance_score`, `shippable_rate`), and the agent read all of
   * it as production signal for this prompt. An allowlist fails closed.
   */
  const OWN_CHECKS = new Set<string>(CHECK_NAMES);

  const buckets = new Map<string, { values: number[]; comments: string[] }>();
  for (const score of scores) {
    if (typeof score.value !== "number") continue;
    if (!OWN_CHECKS.has(score.name)) continue;
    const bucket = buckets.get(score.name) ?? { values: [], comments: [] };
    bucket.values.push(score.value);
    if (score.comment && score.value < 0.999) bucket.comments.push(score.comment);
    buckets.set(score.name, bucket);
  }

  return [...buckets]
    .map(([check, { values, comments }]) => ({
      check,
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      samples: values.length,
      exampleComment: comments[0],
    }))
    .filter((w) => w.mean < 0.999)
    .sort((a, b) => a.mean - b.mean);
}

await main(async () => {
  const args = parseArgs();
  const lookbackHours = typeof args.hours === "string" ? Number(args.hours) : 24;
  const autoGate = !args["no-gate"];

  heading("Act 4 — agent-proposed prompt revision");

  if (MOCK_LLM) {
    console.log(
      `\n  ${yellow("MOCK_LLM=1")} — the proposer needs a real model. ` +
        `Unset MOCK_LLM to run this step.\n`,
    );
    return 1;
  }

  // --- 1. what is production getting wrong? -------------------------------
  console.log(`\n${bold("1. Reading production signal from Langfuse")}`);
  const weakSpots = await readWeakSpots(lookbackHours);

  if (weakSpots.length === 0) {
    console.log(
      `\n  ${green("No failing checks")} in the last ${lookbackHours}h. Nothing to propose.\n` +
        dim(`  Generate some traffic first: npm run notice\n`),
    );
    return 0;
  }

  table(
    ["failing check", "mean", "n", "example finding"],
    weakSpots.map((w) => [
      red(w.check),
      scoreColor(w.mean),
      dim(String(w.samples)),
      dim(
        (w.exampleComment ?? "").length > 64
          ? `${(w.exampleComment ?? "").slice(0, 61)}...`
          : w.exampleComment ?? "-",
      ),
    ]),
  );

  // --- 2. read the live prompt -------------------------------------------
  console.log(`\n${bold("2. Reading the live prompt")}`);
  const live = await fetchPrompt({ label: PRODUCTION_LABEL });
  console.log(
    `  prompt ${bold(`v${live.version}`)} ${dim(`(label "${PRODUCTION_LABEL}")`)}`,
  );

  const liveMessages = live.prompt as Array<{ role: string; content: string }>;
  const systemMessage = liveMessages.find((m) => m.role === "system")?.content ?? "";
  const userMessage = liveMessages.find((m) => m.role === "user")?.content ?? "";

  // --- 3. propose a revision ---------------------------------------------
  console.log(`\n${bold("3. Drafting a revision")} ${dim(`(${PROPOSER_MODEL})`)}`);

  const client = new OpenAI();

  const proposal = await startActiveObservation(
    "propose-prompt-revision",
    async (generation) => {
      const findings = weakSpots
        .map(
          (w) =>
            `- ${w.check}: mean ${w.mean.toFixed(2)} over ${w.samples} production scores. ` +
            `Example finding: ${w.exampleComment ?? "(none)"}`,
        )
        .join("\n");

      const system =
        "You are a prompt engineer working on a US consumer lender's adverse action notice " +
        "generator, governed by ECOA / Regulation B and FCRA 615(a).\n\n" +
        "You are given the live prompt and the checks it is currently failing in production. " +
        "Revise the prompt so it passes those checks.\n\n" +
        "Hard constraints:\n" +
        "- Address EVERY failing check in the list you are given. Do not fix only the ones " +
        "you find most interesting, and do not substitute a problem you inferred from reading " +
        "the prompt for one that is actually being measured. If you also want to harden " +
        "something that is not failing, do that in addition, never instead.\n" +
        "- Preserve every {{variable}} placeholder exactly as spelled. Inventing, renaming or " +
        "dropping one breaks the application.\n" +
        "- Do not weaken any existing requirement in order to fix another.\n" +
        "- Required regulatory text must be reproduced verbatim, never summarised.\n" +
        "- Change the prompt, not the policy: you may not relax what the checks test for.\n" +
        "- Be surgical. A rewrite nobody can review is worse than a targeted edit.";

      generation.update({
        input: { findings, systemMessage, userMessage },
        model: PROPOSER_MODEL,
        // The agent's own call is traced too, and linked to the prompt version
        // it is revising — the proposal is as observable as the production path.
        prompt: {
          name: live.name,
          version: live.version,
          isFallback: live.isFallback,
        },
      });

      const response = await client.responses.parse({
        model: PROPOSER_MODEL,
        max_output_tokens: 8000,
        // Rewriting a regulated prompt is the one place in this app worth
        // spending reasoning tokens on.
        reasoning: { effort: "high" },
        text: { format: zodTextFormat(ProposedPrompt, "proposed_prompt") },
        instructions: system,
        input: [
          {
            role: "user",
            content:
              `Checks failing in production:\n${findings}\n\n` +
              `Current system message:\n---\n${systemMessage}\n---\n\n` +
              `Current user message:\n---\n${userMessage}\n---`,
          },
        ],
      });

      generation.update({
        output: response.output_parsed,
        usageDetails: {
          input: response.usage?.input_tokens ?? 0,
          output: response.usage?.output_tokens ?? 0,
        },
      });

      return response.output_parsed;
    },
    { asType: "generation" },
  );

  if (!proposal) {
    console.log(`\n  ${red("The proposer returned no parseable revision.")}\n`);
    return 1;
  }

  // Guard the one thing a bad proposal can genuinely break.
  const requiredVars = [...systemMessage.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
  const proposedText = `${proposal.system_message}\n${proposal.user_message}`;
  const droppedVars = [...new Set(requiredVars)].filter(
    (v) => !proposedText.includes(`{{${v}}}`),
  );

  if (droppedVars.length > 0) {
    console.log(
      `\n  ${red("Rejected before publishing.")} The proposal dropped template ` +
        `variable(s): ${droppedVars.join(", ")}.`,
    );
    console.log(
      dim("  A proposal that breaks the template never reaches Langfuse at all.\n"),
    );
    return 1;
  }

  console.log(`  ${dim("diagnosis:")} ${proposal.reasoning}`);

  // --- 4. publish as a candidate -----------------------------------------
  console.log(`\n${bold("4. Publishing as a candidate")}`);
  const candidate = await langfuse.prompt.create({
    name: PROMPT_NAME,
    type: "chat",
    prompt: [
      { role: "system", content: proposal.system_message },
      { role: "user", content: proposal.user_message },
    ],
    // Deliberately NOT "production". The agent can propose; it cannot deploy.
    labels: [CANDIDATE_LABEL],
    tags: live.tags,
    commitMessage: `[agent] ${proposal.commit_message}`,
    // Carry the policy forward unchanged: the agent revises wording, not the
    // yardstick it is measured against.
    config: live.config,
  });

  console.log(
    `  ${green("created")} ${bold(`v${candidate.version}`)} ` +
      `labels=[${candidate.labels.join(", ")}]`,
  );
  console.log(dim(`            ${candidate.commitMessage}`));

  // Leave the reasoning on the trace so a human can reply to it in the UI.
  const traceId = getActiveTraceId();
  if (traceId) {
    try {
      const projects = await langfuse.api.projects.get();
      const projectId = projects.data[0]?.id;
      if (projectId) {
        await langfuse.api.comments.create({
          projectId,
          objectType: "TRACE",
          objectId: traceId,
          content:
            `**Agent proposal: \`${PROMPT_NAME}\` v${candidate.version}** ` +
            `(from v${live.version})\n\n` +
            `**Targets:** ${weakSpots.map((w) => `\`${w.check}\` (${w.mean.toFixed(2)})`).join(", ")}\n\n` +
            `**Reasoning:** ${proposal.reasoning}\n\n` +
            `Awaiting human review. Promotion requires a 100% shippable rate on ` +
            `the golden dataset.`,
        });
        console.log(dim(`            rationale posted as a comment on the trace`));
      }
    } catch {
      // Comments are a nice-to-have; never fail a proposal over one.
    }
  }

  // --- 5. run the same gate ----------------------------------------------
  if (!autoGate) {
    console.log(
      `\n  ${dim("--no-gate")} skipping evaluation. Run ` +
        `${bold(`npm run experiment -- --versions ${live.version},${candidate.version}`)}\n`,
    );
    return 0;
  }

  console.log(`\n${bold("5. Running the same gate a human run uses")}`);
  const summaries = [
    await scoreVersion(live.version, "baseline"),
    await scoreVersion(candidate.version, "agent-candidate"),
  ];
  printComparison(summaries);

  // --- 6. hand back to a human -------------------------------------------
  const candidateSummary = summaries[1]!;
  const baselineSummary = summaries[0]!;

  console.log(`\n${bold("6. Handing back to a human")}`);
  console.log(
    `  baseline  v${baselineSummary.version}  shippable ${scoreColor(baselineSummary.shippableRate)}\n` +
      `  candidate v${candidateSummary.version}  shippable ${scoreColor(candidateSummary.shippableRate)}`,
  );

  if (candidateSummary.shippableRate >= 0.999) {
    console.log(
      `\n  ${green("The agent's candidate passes the gate.")} ` +
        `It is still not live.\n` +
        `  A human promotes it, and that action is attributed in the audit trail:\n\n` +
        `    ${bold(`npm run promote -- --version ${candidateSummary.version}`)}\n`,
    );
  } else if (candidateSummary.shippableRate > baselineSummary.shippableRate) {
    console.log(
      `\n  ${yellow("Improved but still not shippable.")} ` +
        `The gate holds the line.\n` +
        `  Run ${bold("npm run propose")} again — it will now see the remaining failures.\n`,
    );
  } else {
    console.log(
      `\n  ${red("The agent made it no better.")} ` +
        `Nothing was promoted, and nothing broke.\n` +
        `  ${dim("This is the system working. An ungated agent would have shipped this.")}\n`,
    );
  }

  console.log(
    `  ${magenta("The point:")} the agent read production data, wrote a versioned\n` +
      `  proposal with a reviewable rationale, and ran the same gate as a human —\n` +
      `  through one API, against one artefact. ${bold("Promotion stayed human.")}\n`,
  );
  console.log(
    dim(`  Review the diff: ${LANGFUSE_BASE_URL} -> Prompts -> ${PROMPT_NAME} -> Versions\n`),
  );
});
