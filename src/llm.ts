import OpenAI from "openai";
import { MOCK_LLM, assertOpenAiEnv } from "./env.js";

/**
 * One message of a compiled Langfuse chat prompt.
 *
 * `ChatPromptClient.compile()` is loosely typed because it can also emit
 * unresolved placeholders, so we narrow to the shape we actually send.
 */
export interface CompiledMessage {
  role: string;
  content: string;
}

/**
 * Default model, used only when a prompt version's config does not name one.
 *
 * `gpt-6.1-sol` balances intelligence and cost — near-flagship quality at a
 * fraction of `gpt-6-astra`'s token price, which matters here because one gate
 * run is 8 cases x 2 versions x (1 generation + 1 judge call). To change it,
 * edit `config.model` in `prompts/*.json` and publish a new version; you do not
 * touch this file. That is the point of the demo.
 */
export const DEFAULT_MODEL = "gpt-6.1-sol";

let client: OpenAI | null = null;

/**
 * Build the client on first use, not at import time.
 *
 * Importing this module must not throw: the CLI runner catches errors raised
 * inside a command and prints one readable line, whereas a throw during module
 * evaluation escapes as a stack trace. Key problems are the first thing a new
 * user hits, so they deserve the readable version.
 */
function getClient(): OpenAI | null {
  if (MOCK_LLM) return null;
  if (!client) {
    assertOpenAiEnv();
    client = new OpenAI();
  }
  return client;
}

/** Model settings read from the prompt version's `config`, not from this file. */
export interface ModelSettings {
  model: string;
  max_output_tokens: number;
  /** Reasoning effort: none | minimal | low | medium | high | xhigh | max. */
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface LlmResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Pull model settings out of a prompt version's config, with safe defaults. */
export function settingsFromConfig(config: unknown): ModelSettings {
  const c = (config ?? {}) as Partial<ModelSettings> & {
    /** Tolerated so a prompt version seeded before the OpenAI switch still runs. */
    max_tokens?: number;
    effort?: ModelSettings["reasoning_effort"];
  };

  return {
    model: c.model ?? DEFAULT_MODEL,
    max_output_tokens: c.max_output_tokens ?? c.max_tokens ?? 2000,
    reasoning_effort: c.reasoning_effort ?? c.effort ?? "low",
  };
}

/**
 * Call the model with a compiled Langfuse chat prompt.
 *
 * Note what this function does *not* contain: no prompt text, no model name, no
 * reasoning effort. All of it arrives from the prompt version. This file is
 * plumbing, and plumbing is the only thing that should need a deploy.
 *
 * Uses the Responses API, which is OpenAI's current surface: the system prompt
 * goes in `instructions` and the turns go in `input`.
 */
export async function callModel(
  messages: CompiledMessage[],
  settings: ModelSettings,
): Promise<LlmResult> {
  const openai = getClient();
  if (!openai) return mockNotice(messages, settings);

  // Langfuse chat prompts carry a `system` role; the Responses API takes the
  // system prompt as `instructions` instead, so split it out here.
  const instructions = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const input = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    }));

  const response = await openai.responses.create({
    model: settings.model,
    max_output_tokens: settings.max_output_tokens,
    ...(instructions ? { instructions } : {}),
    ...(settings.reasoning_effort
      ? { reasoning: { effort: settings.reasoning_effort } }
      : {}),
    input,
  });

  return {
    text: response.output_text.trim(),
    model: response.model,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

/**
 * Deterministic stand-in for the model, used only when MOCK_LLM=1.
 *
 * It exists so the whole pipeline — seed, experiment, promote, CI gate — can be
 * rehearsed with no OpenAI key and no spend. It reads the compiled prompt and
 * imitates how a model would follow it: when the prompt demands verbatim
 * reproduction it complies, and when the prompt is loose it paraphrases. That
 * makes the evaluators discriminate between versions offline, which is what you
 * want the night before a talk. It is not a model, and the scores it produces
 * are illustrative only.
 */
function mockNotice(messages: CompiledMessage[], settings: ModelSettings): LlmResult {
  const joined = messages.map((m) => m.content).join("\n");
  const userTurn = messages
    .filter((m) => m.role !== "system")
    .map((m) => m.content)
    .join("\n");

  // Read the prompt's *instructions* rather than matching one version's exact
  // phrasing, so a prompt this file has never seen still behaves sensibly.
  const demandsVerbatim = /\b(verbatim|exactly as supplied|word for word)\b/i.test(joined);
  const forbidsFutureTalk =
    /\b(no statement about future applications|do not offer any advice or commentary about future applications|do not offer advice about future applications)\b/i.test(
      joined,
    );

  // The two instructions that decide whether internal context leaks.
  const asksHowClose =
    /how close the application came|how close they came|finely balanced/i.test(joined);
  const forbidsDecisionRecord =
    /decision record is internal|never reproduce, quote, paraphrase/i.test(joined);

  const reasons = [...userTurn.matchAll(/^\s*-\s*(.+)$/gm)].map((m) => m[1]!.trim());
  // Stop at the first blank line: the user turn has further sections after the
  // score block (the decision record, the sender), and they must not be swept in.
  const scoreBlock = /Credit score used:([\s\S]*?)(?:\n\n|$)/
    .exec(userTurn)?.[1]
    ?.trim();
  const name = /Applicant:\s*(.+)/.exec(userTurn)?.[1]?.trim() ?? "Applicant";
  const product = /Product:\s*(.+)/.exec(userTurn)?.[1]?.trim() ?? "the product";

  // The stand-in reproduces any required disclosure the prompt actually hands
  // it. Remove a block from the prompt and it disappears from the letter —
  // which is exactly the regression class the gate exists to catch.
  const ecoaInPrompt = joined.includes(
    "The Federal Equal Credit Opportunity Act prohibits creditors from discriminating",
  );
  const ECOA =
    "The Federal Equal Credit Opportunity Act prohibits creditors from discriminating " +
    "against credit applicants on the basis of race, color, religion, national origin, sex, " +
    "marital status, age, because all or part of the applicant's income derives from any " +
    "public assistance program, or because the applicant has in good faith exercised any " +
    "right under the Consumer Credit Protection Act.";

  const regulator = /(Federal Deposit Insurance Corporation, Consumer Response Center)/
    .exec(joined)?.[1];
  const regulatorAddress = /(1100 Walnut Street, Box #11, Kansas City, MO 64106)/
    .exec(joined)?.[1];

  // A loose prompt gets loose output: the stand-in paraphrases, exactly as a
  // model does when nothing tells it not to.
  const renderedReasons = demandsVerbatim
    ? reasons.map((r) => `- ${r}`).join("\n")
    : reasons.map((r) => `- ${paraphrase(r)}`).join("\n");

  const parts = [
    `Dear ${name},`,
    "",
    `Thank you for your recent application for ${product}. After reviewing your application, we are unable to approve it at this time.`,
    "",
    "The specific reasons for this decision are:",
    renderedReasons,
  ];

  if (scoreBlock) {
    parts.push(
      "",
      demandsVerbatim ? scoreBlock : scoreBlock.replace(/\b(\d{3})\b/, "approximately $1"),
    );
  }

  // Hidden Context Exposure, simulated faithfully.
  //
  // The decision record is in the prompt on every request. Asked to explain how
  // close the application came, the stand-in does what a model does: it reaches
  // for the most precise thing in its context and quotes the numbers. And it
  // only does so when the application actually WAS close — so the leak is
  // intermittent, which is exactly why testing one case finds nothing.
  const risk = Number(/Risk score:\s*([\d.]+)/.exec(joined)?.[1]);
  const threshold = Number(/Decline threshold:\s*([\d.]+)/.exec(joined)?.[1]);
  const wasClose =
    Number.isFinite(risk) && Number.isFinite(threshold) && risk - threshold <= 0.05;

  if (asksHowClose && !forbidsDecisionRecord && wasClose) {
    parts.push(
      "",
      `Your application was finely balanced: it scored ${risk} against our ` +
        `decline threshold of ${threshold}, so it fell only just short.`,
    );
  }

  if (ecoaInPrompt) parts.push("", ECOA);
  if (regulator) parts.push("", regulator);
  if (regulatorAddress) parts.push(regulatorAddress);

  if (!forbidsFutureTalk) {
    parts.push("", "We encourage you to reapply once your circumstances have improved.");
  }

  parts.push("", "Sincerely,", "Northwind Lending, N.A.");

  const text = parts.join("\n");
  return {
    text,
    model: `${settings.model} (MOCK_LLM)`,
    inputTokens: Math.ceil(joined.length / 4),
    outputTokens: Math.ceil(text.length / 4),
  };
}

/** Crude reworder, so a loose prompt visibly fails the verbatim check. */
function paraphrase(sentence: string): string {
  return sentence
    .replace(/^Your total monthly debt payments are high relative to your monthly income\.$/,
      "Your existing debt load is high compared with what you earn each month.")
    .replace(/^The length of your credit history is shorter than we require for this product\.$/,
      "You have a relatively short credit history for this product.")
    .replace(/^We were unable to verify the income you reported on your application\.$/,
      "We could not confirm the income figures you gave us.")
    .replace(/^Your credit report shows one or more recent past-due payments\.$/,
      "There are some recent late payments on your credit file.")
    .replace(/\byou require\b/g, "is required");
}
