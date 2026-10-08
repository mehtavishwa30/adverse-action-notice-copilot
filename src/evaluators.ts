import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { startActiveObservation } from "@langfuse/tracing";
import type { Evaluation, Evaluator, RunEvaluator } from "@langfuse/client";

import { MOCK_LLM } from "./env.js";
import { DEFAULT_MODEL } from "./llm.js";
import type { ApplicationCase } from "./domain/types.js";
import {
  runComplianceChecks,
  complianceScore,
  type CompliancePolicy,
} from "./domain/compliance.js";

/**
 * The evaluation gate.
 *
 * Two kinds of evaluator, and the split matters more than either half:
 *
 *   1. Deterministic code checks — same function as the runtime guardrails.
 *      Cheap, reproducible, and the ones a compliance officer will actually
 *      trust, because they can read them.
 *   2. One LLM judge, for the single question code cannot answer: did the letter
 *      state a reason that was never in the decision record?
 *
 * Reach for the judge only where determinism genuinely runs out. A suite that is
 * all judge is slow, expensive, and non-reproducible; a suite that is all code
 * cannot catch invention.
 */

/**
 * Judge model. Deliberately the same tier as the generator — a judge weaker than
 * the thing it grades is a false sense of safety.
 */
const JUDGE_MODEL = DEFAULT_MODEL;

let judgeClient: OpenAI | null = null;

/** Built on first use, so importing this module never throws on a bad key. */
function getJudgeClient(): OpenAI | null {
  if (MOCK_LLM) return null;
  if (!judgeClient) judgeClient = new OpenAI();
  return judgeClient;
}

/** Wrap the deterministic compliance checks as experiment evaluators. */
export function complianceEvaluators(policy: CompliancePolicy): Evaluator[] {
  return [
    async ({ input, output }): Promise<Evaluation[]> => {
      const appCase = input as ApplicationCase;
      const notice = String(output ?? "");
      const checks = runComplianceChecks(notice, appCase, policy);

      return [
        ...checks.map((c) => ({
          name: c.name,
          value: c.value,
          comment: c.comment,
          dataType: "NUMERIC" as const,
        })),
        {
          name: "compliance_score",
          value: complianceScore(checks),
          comment: `Mean of ${checks.length} deterministic checks.`,
          dataType: "NUMERIC" as const,
        },
      ];
    },
  ];
}

const JudgeVerdict = z.object({
  invented_reasons: z
    .array(z.string())
    .describe(
      "Reasons for the denial stated in the letter that do not correspond to any approved " +
        "disclosure in the decision record. Empty array if every stated reason is accounted for.",
    ),
  implies_future_outcome: z
    .boolean()
    .describe(
      "True if the letter invites another application, suggests timing for one, promises " +
        "review or reconsideration, or implies any future approval.",
    ),
  tone_acceptable: z
    .boolean()
    .describe(
      "True if the tone is plain and respectful, with no sales language, no blame, and no " +
        "false sympathy.",
    ),
  rationale: z.string().describe("One or two sentences explaining the verdict."),
});

/**
 * LLM-as-judge for reason invention and implied commitments.
 *
 * Invention is the failure the deterministic checks structurally cannot catch:
 * `reason_code_fidelity` proves the approved sentences are *present*, but not
 * that the model refrained from adding a fifth reason of its own.
 */
export const judgeEvaluator: Evaluator = async ({ input, output }) => {
  const appCase = input as ApplicationCase;
  const notice = String(output ?? "");

  const judge = getJudgeClient();
  if (!judge) {
    // Offline rehearsal: the stand-in generator never invents reasons, so report
    // a neutral pass and make it obvious in the comment that no judge ran.
    return [
      {
        name: "no_invented_reasons",
        value: 1,
        comment: "MOCK_LLM=1 — no judge call was made.",
        dataType: "NUMERIC" as const,
      },
    ];
  }

  return startActiveObservation(
    "judge-invented-reasons",
    async (evaluator) => {
      const approved = appCase.reasonCodes
        .map((r) => `- ${r.disclosureText}`)
        .join("\n");

      evaluator.update({
        input: { approved, notice },
        metadata: { judgeModel: JUDGE_MODEL },
      });

      const response = await judge.responses.parse({
        model: JUDGE_MODEL,
        max_output_tokens: 2000,
        reasoning: { effort: "low" },
        text: { format: zodTextFormat(JudgeVerdict, "judge_verdict") },
        instructions:
          "You audit adverse action notices for a US consumer lender against Regulation B. " +
          "You are given the approved reason disclosures from the decision record and the " +
          "letter that was sent. Judge only what is asked. Be strict: a reason that is " +
          "merely implied still counts as stated.",
        input: [
          {
            role: "user",
            content:
              `Approved reason disclosures from the decision record:\n${approved}\n\n` +
              `Letter as sent:\n---\n${notice}\n---`,
          },
        ],
      });

      const verdict = response.output_parsed;
      evaluator.update({ output: verdict });

      if (!verdict) {
        return [
          {
            name: "no_invented_reasons",
            value: 0,
            comment: "Judge returned no parseable verdict.",
            dataType: "NUMERIC" as const,
          },
        ];
      }

      return [
        {
          name: "no_invented_reasons",
          value: verdict.invented_reasons.length === 0 ? 1 : 0,
          comment:
            verdict.invented_reasons.length === 0
              ? `No invented reasons. ${verdict.rationale}`
              : `Invented: ${verdict.invented_reasons.join("; ")}`,
          dataType: "NUMERIC" as const,
        },
        {
          name: "no_implied_commitments",
          value: verdict.implies_future_outcome ? 0 : 1,
          comment: verdict.rationale,
          dataType: "NUMERIC" as const,
        },
        {
          name: "tone",
          value: verdict.tone_acceptable ? 1 : 0,
          comment: verdict.rationale,
          dataType: "NUMERIC" as const,
        },
      ];
    },
    { asType: "evaluator" },
  );
};

/**
 * Run-level gate.
 *
 * `shippable` is the number that decides whether a prompt version is allowed to
 * carry the `production` label. It is deliberately all-or-nothing per item: a
 * letter that is 95% compliant is not 95% shippable, it is a violation.
 */
export const gateEvaluator: RunEvaluator = async ({ itemResults }) => {
  const scoreOf = (evaluations: Evaluation[], name: string): number | undefined => {
    const hit = evaluations.find((e) => e.name === name);
    return typeof hit?.value === "number" ? hit.value : undefined;
  };

  const perItem = itemResults.map((r) => {
    const values = r.evaluations
      .filter((e) => typeof e.value === "number")
      .map((e) => e.value as number);
    // Tolerant compare: these values come from divisions, so never test === 1.
    const allPerfect = values.length > 0 && values.every((v) => v >= 0.999);
    return {
      compliance: scoreOf(r.evaluations, "compliance_score") ?? 0,
      shippable: allPerfect,
    };
  });

  const meanCompliance =
    perItem.reduce((sum, i) => sum + i.compliance, 0) / Math.max(perItem.length, 1);
  const shippableCount = perItem.filter((i) => i.shippable).length;

  return [
    {
      name: "mean_compliance",
      value: Number(meanCompliance.toFixed(4)),
      comment: `Mean deterministic compliance across ${perItem.length} golden cases.`,
      dataType: "NUMERIC" as const,
    },
    {
      name: "shippable_rate",
      value: Number((shippableCount / Math.max(perItem.length, 1)).toFixed(4)),
      comment: `${shippableCount}/${perItem.length} cases passed every check. ` +
        `Promotion requires 100%.`,
      dataType: "NUMERIC" as const,
    },
  ];
};
