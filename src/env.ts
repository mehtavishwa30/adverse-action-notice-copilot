import "dotenv/config";

/** The prompt under management. One name, many versions, labels as environments. */
export const PROMPT_NAME = "adverse-action-notice";

/** The golden dataset the gate runs against. */
export const DATASET_NAME = "adverse-action-golden-cases";

/**
 * Label the running application serves.
 *
 * This is the whole deployment mechanism. Moving this label in the Langfuse UI
 * changes what production serves — no build, no deploy, no restart.
 */
export const PRODUCTION_LABEL = "production";

/** Label a proposed-but-ungated version carries until a human promotes it. */
export const CANDIDATE_LABEL = "candidate";

/**
 * Prompt cache TTL for the serving path.
 *
 * Langfuse caches the prompt in-process, so the hot path costs nothing after the
 * first fetch. The TTL is the only latency between a label move and production
 * serving the new version. 60s is a good demo value; production systems commonly
 * run 300s and accept a five-minute rollout.
 */
export const PROMPT_CACHE_TTL_SECONDS = Number(process.env.PROMPT_CACHE_TTL_SECONDS ?? 60);

/**
 * Environment tag applied to this app's traces and scores.
 *
 * Experiment runs are tagged `sdk-experiment` by the SDK instead, which is how
 * the proposing agent tells real production signal apart from its own eval runs.
 */
export const TRACING_ENVIRONMENT = process.env.LANGFUSE_TRACING_ENVIRONMENT ?? "demo";

/** Offline rehearsal: run the full pipeline with no OpenAI key and no spend. */
export const MOCK_LLM = process.env.MOCK_LLM === "1";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.startsWith("pk-lf-...") || value.startsWith("sk-lf-...")) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill in your Langfuse keys ` +
        `(cloud.langfuse.com -> Settings -> API Keys).`,
    );
  }
  return value;
}

/** Validate Langfuse credentials up front so failures are legible, not stack traces. */
export function assertLangfuseEnv(): void {
  required("LANGFUSE_PUBLIC_KEY");
  required("LANGFUSE_SECRET_KEY");
}

/** Validate the OpenAI key unless we are in offline rehearsal mode. */
export function assertOpenAiEnv(): void {
  if (MOCK_LLM) return;

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "Missing OPENAI_API_KEY. Set it in .env, or run with MOCK_LLM=1 to " +
        "rehearse the pipeline without calling a model.",
    );
  }
  // Catches the most common .env slip: the placeholder left in place, or an
  // Anthropic key pasted into the OpenAI slot.
  if (!key.startsWith("sk-")) {
    throw new Error(
      "OPENAI_API_KEY does not look like an OpenAI key (expected it to start " +
        "with \"sk-\"). Check .env.",
    );
  }
  if (key.startsWith("sk-ant-")) {
    throw new Error(
      "OPENAI_API_KEY holds an Anthropic key (\"sk-ant-...\"). This project " +
        "uses the OpenAI SDK — paste an OpenAI key from " +
        "https://platform.openai.com/api-keys.",
    );
  }
}

export const LANGFUSE_BASE_URL =
  process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com";
