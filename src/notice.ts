import {
  startActiveObservation,
  updateActiveObservation,
  getActiveTraceId,
} from "@langfuse/tracing";
import type { ChatPromptClient } from "@langfuse/client";

import { langfuse } from "./langfuse.js";
import { callModel, settingsFromConfig, type CompiledMessage } from "./llm.js";
import {
  PROMPT_NAME,
  PROMPT_CACHE_TTL_SECONDS,
  PRODUCTION_LABEL,
  TRACING_ENVIRONMENT,
} from "./env.js";
import { INSTITUTION } from "./domain/institution.js";
import type { ApplicationCase } from "./domain/types.js";
import {
  runComplianceChecks,
  complianceScore,
  policyFromPromptConfig,
  type CheckResult,
} from "./domain/compliance.js";

/**
 * The serving path.
 *
 * Read this file top to bottom and notice what is missing: there is no prompt
 * text here, no model name, no temperature, no word ceiling. Those live in the
 * prompt version in Langfuse. This file is the part that needs a deploy; the
 * part Compliance actually cares about is not.
 */

export interface NoticeResult {
  notice: string;
  /** Which prompt version actually served this request. */
  promptVersion: number;
  promptLabels: string[];
  promptCommitMessage: string | null | undefined;
  /** True when Langfuse was unreachable and the in-code fallback was used. */
  usedFallback: boolean;
  model: string;
  checks: CheckResult[];
  complianceScore: number;
  traceId: string | undefined;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Last-resort prompt, compiled into the binary.
 *
 * Prompt management must not become a new single point of failure. If Langfuse
 * is unreachable *and* the cache is cold, `prompt.get` returns this instead of
 * throwing, and the resulting trace is flagged `isFallback` so you can alert on
 * it. For a regulated, customer-facing path this is not optional.
 */
const FALLBACK_MESSAGES = [
  {
    role: "system",
    content:
      "You write adverse action notices for {{institution_name}} under the Equal Credit " +
      "Opportunity Act and Regulation B.\n\n" +
      "Reproduce every approved reason disclosure exactly as supplied, as its own bullet. " +
      "State no reason that is not supplied. If a credit score block is supplied, reproduce " +
      "its figures exactly. Never mention internal models, scores or thresholds. Make no " +
      "statement about future applications.\n\n" +
      "Include verbatim:\n\n" +
      "The Federal Equal Credit Opportunity Act prohibits creditors from discriminating " +
      "against credit applicants on the basis of race, color, religion, national origin, sex, " +
      "marital status, age, because all or part of the applicant's income derives from any " +
      "public assistance program, or because the applicant has in good faith exercised any " +
      "right under the Consumer Credit Protection Act.\n\n" +
      "Then the regulator block on its own lines:\n\n{{regulator_name}}\n{{regulator_address}}\n\n" +
      "Output the letter body only.",
  },
  {
    role: "user",
    content:
      "Application: {{application_id}}\nApplicant: {{applicant_name}}\n" +
      "Product: {{product_name}}\nDecision date: {{decision_date}}\n\n" +
      "Approved reason disclosures — reproduce each one verbatim:\n{{reason_disclosures}}\n\n" +
      "{{score_disclosure}}\n\nSender:\n{{institution_name}}\n{{institution_address}}",
  },
];

/**
 * Turn a case into the variables the prompt template expects.
 *
 * This is the main seam when adapting the kit to your own domain: change the
 * shape on the left, and the prompt templates in `prompts/` change to match.
 * Exported for that reason, and because tests and notebooks want it.
 */
export function promptVariables(appCase: ApplicationCase): Record<string, string> {
  const reasonDisclosures = appCase.reasonCodes
    .map((r) => `- ${r.disclosureText}`)
    .join("\n");

  // Only emit the FCRA block when a score was actually used in the decision.
  const scoreDisclosure = appCase.creditScore
    ? [
        "Credit score used:",
        `Your credit score: ${appCase.creditScore.score}`,
        `Scores range from ${appCase.creditScore.range[0]} to ${appCase.creditScore.range[1]}`,
        `Provided by: ${appCase.creditScore.source}`,
        `Date obtained: ${appCase.creditScore.obtainedOn}`,
      ].join("\n")
    : "No credit score was used in this decision.";

  // The full decision record, internal fields included.
  //
  // This is the uncomfortable part, and it is deliberate: real systems hand the
  // model the whole record because it is convenient and because the model does
  // produce better letters with the context. OWASP calls the resulting risk
  // Hidden Context Exposure (LLM08:2026) — non-user-facing content assembled
  // into a model's context. Once it is in the context window, the ONLY thing
  // standing between the internal risk threshold and the customer is an
  // instruction in the prompt.
  //
  // Which is the whole argument for managing that instruction as a versioned,
  // tested, revertible artifact rather than a string literal.
  const decisionRecord = [
    `Scorecard: ${appCase.internal.modelVersion}`,
    `Risk score: ${appCase.internal.riskScore}`,
    `Decline threshold: ${appCase.internal.decisionThreshold}`,
  ].join("\n");

  return {
    institution_name: INSTITUTION.name,
    institution_address: INSTITUTION.address,
    regulator_name: INSTITUTION.regulator.name,
    regulator_address: INSTITUTION.regulator.address,
    application_id: appCase.applicationId,
    applicant_name: appCase.applicantName,
    product_name: appCase.productName,
    decision_date: appCase.decisionDate,
    reason_disclosures: reasonDisclosures,
    score_disclosure: scoreDisclosure,
    decision_record: decisionRecord,
  };
}

/**
 * Fetch the prompt version this request should use.
 *
 * `label` is the deployment pointer — normally `production`. Passing an explicit
 * `version` is what the experiment runner does so it can serve two versions
 * side by side in the same process.
 */
export async function fetchPrompt(opts: {
  label?: string;
  version?: number;
}): Promise<ChatPromptClient> {
  if (opts.version !== undefined) {
    // Pinned version: no cache, because experiments must read exactly this one.
    return langfuse.prompt.get(PROMPT_NAME, {
      type: "chat",
      version: opts.version,
      cacheTtlSeconds: 0,
      fallback: FALLBACK_MESSAGES,
    });
  }

  return langfuse.prompt.get(PROMPT_NAME, {
    type: "chat",
    label: opts.label ?? PRODUCTION_LABEL,
    // Cached in-process: the hot path does not hit the network.
    cacheTtlSeconds: PROMPT_CACHE_TTL_SECONDS,
    fallback: FALLBACK_MESSAGES,
  });
}

/**
 * Generate one adverse action notice, fully traced and scored.
 *
 * The trace that comes out of this carries the prompt version that produced it,
 * which is what makes "version 2 regressed on reason fidelity" a question you
 * can answer from production data rather than from memory.
 */
export async function generateNotice(opts: {
  appCase: ApplicationCase;
  label?: string;
  version?: number;
  /** Skip writing scores to Langfuse (the experiment runner records its own). */
  skipScores?: boolean;
}): Promise<NoticeResult> {
  const { appCase } = opts;

  return startActiveObservation("adverse-action-notice", async (span) => {
    const prompt = await fetchPrompt({ label: opts.label, version: opts.version });

    // The policy travels with the prompt version. Promoting a prompt promotes
    // the guardrail it was evaluated against — they cannot drift apart.
    const policy = policyFromPromptConfig(prompt.config);
    const settings = settingsFromConfig(prompt.config);

    const messages = prompt.compile(promptVariables(appCase)) as CompiledMessage[];

    span.update({
      input: {
        applicationId: appCase.applicationId,
        product: appCase.productName,
        reasonCodes: appCase.reasonCodes.map((r) => r.code),
        creditScoreUsed: Boolean(appCase.creditScore),
      },
    });

    const result = await startActiveObservation(
      "notice-generation",
      async (generation) => {
        // Linking the prompt to the generation is the one line that turns
        // Langfuse from a log viewer into a control plane: every metric and
        // score below is now attributable to prompt v{N}.
        generation.update({
          input: messages,
          model: settings.model,
          modelParameters: {
            max_output_tokens: settings.max_output_tokens,
            reasoning_effort: settings.reasoning_effort ?? "default",
          },
          prompt: {
            name: prompt.name,
            version: prompt.version,
            isFallback: prompt.isFallback,
          },
        });

        const llm = await callModel(messages, settings);

        generation.update({
          output: llm.text,
          usageDetails: { input: llm.inputTokens, output: llm.outputTokens },
        });

        return llm;
      },
      { asType: "generation" },
    );

    // Deterministic guardrails run on every single production request, not just
    // in the eval suite. Same function, three call sites.
    const checks = runComplianceChecks(result.text, appCase, policy);
    const score = complianceScore(checks);

    span.update({ output: { notice: result.text, complianceScore: score } });

    const traceId = getActiveTraceId();

    if (!opts.skipScores && traceId) {
      // Scores on the trace are what the prompt's Metrics tab aggregates, and
      // what the proposing agent later reads back to find weak spots.
      for (const check of checks) {
        langfuse.score.create({
          name: check.name,
          value: check.value,
          traceId,
          comment: check.comment,
          dataType: "NUMERIC",
          environment: TRACING_ENVIRONMENT,
        });
      }
      langfuse.score.create({
        name: "compliance_score",
        value: score,
        traceId,
        comment: `Mean of ${checks.length} deterministic checks on prompt v${prompt.version}.`,
        dataType: "NUMERIC",
        environment: TRACING_ENVIRONMENT,
      });
    }

    if (prompt.isFallback) {
      // Worth alerting on: the app is serving the in-code prompt, not the
      // version Compliance approved.
      updateActiveObservation({
        level: "WARNING",
        statusMessage: "Served in-code fallback prompt; Langfuse was unreachable.",
      });
    }

    return {
      notice: result.text,
      promptVersion: prompt.version,
      promptLabels: prompt.labels,
      promptCommitMessage: prompt.commitMessage,
      usedFallback: prompt.isFallback,
      model: result.model,
      checks,
      complianceScore: score,
      traceId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  });
}
