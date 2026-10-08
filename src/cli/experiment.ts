import "../instrumentation.js";
import type { ExperimentResult, Evaluation } from "@langfuse/client";

import { langfuse } from "../langfuse.js";
import { generateNotice, fetchPrompt } from "../notice.js";
import { complianceEvaluators, judgeEvaluator, gateEvaluator } from "../evaluators.js";
import { policyFromPromptConfig } from "../domain/compliance.js";
import {
  PROMPT_NAME,
  DATASET_NAME,
  PRODUCTION_LABEL,
  CANDIDATE_LABEL,
  LANGFUSE_BASE_URL,
} from "../env.js";
import type { ApplicationCase } from "../domain/types.js";
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
} from "./_shared.js";

/**
 * Act 2 — the gate.
 *
 * Runs one or more prompt versions across the golden dataset and prints them
 * side by side. This is the artefact that makes a prompt change reviewable by
 * someone who does not read TypeScript: a compliance officer can look at the
 * `shippable_rate` column and tell you whether to ship.
 *
 * Promotion rule, enforced here and in CI: a version may carry `production`
 * only at a 100% shippable rate. A letter that is 95% compliant is not 95%
 * shippable; it is a violation.
 */

export interface RunSummary {
  version: number;
  labels: string[];
  commitMessage: string | null | undefined;
  runName: string;
  datasetRunUrl: string | undefined;
  /** Mean of each item-level metric across the dataset. */
  metrics: Map<string, number>;
  /** Run-level aggregates from `gateEvaluator`. */
  runMetrics: Map<string, number>;
  shippableRate: number;
  itemCount: number;
}

/** Average each named evaluation across all items in a run. */
function meanMetrics(result: ExperimentResult): Map<string, number> {
  const buckets = new Map<string, number[]>();

  for (const item of result.itemResults) {
    for (const evaluation of item.evaluations as Evaluation[]) {
      if (typeof evaluation.value !== "number") continue;
      const list = buckets.get(evaluation.name) ?? [];
      list.push(evaluation.value);
      buckets.set(evaluation.name, list);
    }
  }

  return new Map(
    [...buckets].map(([name, values]) => [
      name,
      values.reduce((a, b) => a + b, 0) / values.length,
    ]),
  );
}

function runMetricMap(result: ExperimentResult): Map<string, number> {
  return new Map(
    result.runEvaluations
      .filter((e) => typeof e.value === "number")
      .map((e) => [e.name, e.value as number]),
  );
}

/**
 * Score a single prompt version against the golden dataset.
 *
 * Note the two things that come from the prompt version rather than from this
 * file: the text the task runs, and the policy the evaluators judge against.
 * Both are versioned together, so a run can never grade a prompt against
 * somebody else's yardstick.
 */
export async function scoreVersion(version: number, runLabel?: string): Promise<RunSummary> {
  const prompt = await fetchPrompt({ version });
  const policy = policyFromPromptConfig(prompt.config);
  const dataset = await langfuse.dataset.get(DATASET_NAME);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runName = `v${version}-${runLabel ?? "gate"}-${stamp}`;

  const result = await dataset.runExperiment({
    name: `adverse-action-notice v${version}`,
    runName,
    description:
      `Reg B compliance gate for prompt v${version}. ` +
      `${prompt.commitMessage ?? "(no commit message)"}`,
    metadata: {
      promptName: prompt.name,
      promptVersion: String(version),
      promptLabels: prompt.labels.join(","),
    },
    task: async (item) => {
      const appCase = item.input as ApplicationCase;
      // Pin the version so both arms of a comparison run the same inputs
      // through different prompts in the same process.
      const notice = await generateNotice({
        appCase,
        version,
        skipScores: true, // the experiment records its own scores
      });
      return notice.notice;
    },
    evaluators: [...complianceEvaluators(policy), judgeEvaluator],
    runEvaluators: [gateEvaluator],
    maxConcurrency: 4,
  });

  const runMetrics = runMetricMap(result);

  return {
    version,
    labels: prompt.labels,
    commitMessage: prompt.commitMessage,
    runName: result.runName,
    datasetRunUrl: result.datasetRunUrl,
    metrics: meanMetrics(result),
    runMetrics,
    shippableRate: runMetrics.get("shippable_rate") ?? 0,
    itemCount: result.itemResults.length,
  };
}

/** Print the side-by-side comparison that decides the promotion. */
export function printComparison(summaries: RunSummary[]): void {
  const metricNames = [
    ...new Set(summaries.flatMap((s) => [...s.metrics.keys()])),
  ].sort((a, b) => {
    // compliance_score last among item metrics; it is the roll-up.
    if (a === "compliance_score") return 1;
    if (b === "compliance_score") return -1;
    return a.localeCompare(b);
  });

  heading(`Gate results — ${summaries[0]?.itemCount ?? 0} golden cases`);

  const headers = ["metric", ...summaries.map((s) => `v${s.version}`)];
  const rows: string[][] = [];

  for (const metric of metricNames) {
    const cells = summaries.map((s) => {
      const value = s.metrics.get(metric);
      return value === undefined ? dim("-") : scoreColor(value);
    });
    const label = metric === "compliance_score" ? bold(metric) : metric;
    rows.push([label, ...cells]);
  }

  rows.push(["", ...summaries.map(() => "")]);
  rows.push([
    bold("shippable_rate"),
    ...summaries.map((s) => scoreColor(s.shippableRate)),
  ]);

  table(headers, rows);

  console.log();
  for (const s of summaries) {
    const verdict =
      s.shippableRate >= 0.999
        ? green("PASS  may be promoted to production")
        : red("BLOCK not promotable");
    console.log(`  ${bold(`v${s.version}`)}  ${verdict}`);
    console.log(
      dim(
        `       labels: [${s.labels.join(", ") || "none"}]  ` +
          `${s.commitMessage ? `| ${s.commitMessage}` : ""}`,
      ),
    );
    if (s.datasetRunUrl) console.log(dim(`       ${s.datasetRunUrl}`));
  }
}

/** Resolve the `--versions`/`--label` arguments into concrete version numbers. */
async function resolveVersions(args: Record<string, string | true>): Promise<number[]> {
  if (typeof args.versions === "string") {
    return args.versions
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v));
  }

  // Default: whatever is live, plus a candidate if one exists. This is the
  // comparison you actually want 90% of the time.
  const versions: number[] = [];
  const live = await fetchPrompt({ label: PRODUCTION_LABEL });
  if (!live.isFallback) versions.push(live.version);

  if (!args["no-candidate"]) {
    try {
      const candidate = await langfuse.prompt.get(PROMPT_NAME, {
        type: "chat",
        label: CANDIDATE_LABEL,
        cacheTtlSeconds: 0,
      });
      if (!candidate.isFallback && !versions.includes(candidate.version)) {
        versions.push(candidate.version);
      }
    } catch {
      // No candidate labelled yet — scoring production alone is a valid run.
    }
  }

  return versions;
}

// --- CLI -------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  await main(async () => {
    const args = parseArgs();
    const versions = await resolveVersions(args);

    if (versions.length === 0) {
      console.error(
        `No prompt versions to score. Run ${bold("npm run seed")} first.`,
      );
      return 1;
    }

    console.log(
      `\n${dim(`Scoring prompt version(s) ${versions.map((v) => `v${v}`).join(", ")} ` +
        `against "${DATASET_NAME}"...`)}`,
    );

    const summaries: RunSummary[] = [];
    for (const version of versions) {
      summaries.push(await scoreVersion(version));
    }

    printComparison(summaries);

    const best = summaries.find((s) => s.shippableRate >= 0.999);
    console.log();
    if (best) {
      console.log(
        `  Next: ${bold(`npm run promote -- --version ${best.version}`)}` +
          `   ${dim("(or move the label in the Langfuse UI)")}\n`,
      );
    } else {
      console.log(
        `  ${yellow("Nothing is promotable.")} Every version failed at least one case.\n` +
          `  Open a failing case in Langfuse to see which check and why:\n` +
          `  ${blue(`${LANGFUSE_BASE_URL}`)} -> Datasets -> ${DATASET_NAME} -> Runs\n`,
      );
    }
  });
}
