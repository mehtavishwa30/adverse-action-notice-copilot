import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { TRACING_ENVIRONMENT } from "./env.js";

/**
 * OpenTelemetry wiring for the Langfuse JS/TS SDK.
 *
 * Langfuse tracing is plain OTel: `LangfuseSpanProcessor` is a span processor
 * you add to your existing provider. If you already run OTel, Langfuse becomes
 * one more exporter rather than a parallel stack — which is the answer to "does
 * this lock us in?".
 */

/**
 * Redact applicant PII before spans leave the process.
 *
 * For a regulated workload this is the hook that makes tracing acceptable to a
 * privacy office: the mask runs in *your* process, so names, SSNs and account
 * numbers never reach the Langfuse server at all. Self-hosting is the other
 * answer; these compose.
 */
const mask = ({ data }: { data: unknown }): unknown => {
  if (process.env.LANGFUSE_MASK_PII !== "1") return data;

  const redact = (text: string): string =>
    text
      // US SSN
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN_REDACTED]")
      // 13-19 digit card/account numbers, with or without separators
      .replace(/\b(?:\d[ -]?){13,19}\b/g, "[ACCOUNT_REDACTED]")
      // Email addresses
      .replace(/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g, "[EMAIL_REDACTED]");

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]),
      );
    }
    return value;
  };

  return walk(data);
};

/**
 * Exported as an extension point: if you already run OpenTelemetry, drop this
 * processor into your existing provider instead of using the `NodeSDK` below,
 * and Langfuse becomes one more exporter rather than a parallel stack.
 */
export const langfuseSpanProcessor = new LangfuseSpanProcessor({
  mask,
  // Tags every trace so demo data stays separable from real traffic.
  environment: TRACING_ENVIRONMENT,
});

const sdk = new NodeSDK({ spanProcessors: [langfuseSpanProcessor] });
sdk.start();

/**
 * Flush traces before the process exits.
 *
 * Span export is batched and asynchronous. A short-lived CLI that exits without
 * flushing loses its traces — the single most common "why is Langfuse empty?"
 * cause in JS/TS. Every CLI in this repo calls this in a finally block.
 */
export async function shutdownTracing(): Promise<void> {
  await sdk.shutdown();
}
