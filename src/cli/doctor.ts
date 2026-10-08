import "../instrumentation.js";
import { langfuse } from "../langfuse.js";
import {
  PROMPT_NAME,
  DATASET_NAME,
  LANGFUSE_BASE_URL,
  MOCK_LLM,
  PRODUCTION_LABEL,
} from "../env.js";
import { main, heading, green, red, yellow, dim, bold } from "./_shared.js";

/**
 * Pre-flight check. Run this before the talk, not during it.
 *
 * Every line is something that has derailed a live demo: a key in the wrong
 * region, a prompt with no `production` label, an empty dataset.
 */
await main(async () => {
  heading("Langfuse walkthrough — pre-flight");

  const ok = (msg: string) => console.log(`  ${green("ok")}   ${msg}`);
  const warn = (msg: string) => console.log(`  ${yellow("warn")} ${msg}`);
  const bad = (msg: string) => console.log(`  ${red("fail")} ${msg}`);

  let failures = 0;

  console.log(`\n${bold("Environment")}`);
  ok(`Langfuse host  ${LANGFUSE_BASE_URL}`);
  if (MOCK_LLM) {
    warn("MOCK_LLM=1 — model calls are stubbed. Unset it for the live demo.");
  } else if (process.env.OPENAI_API_KEY?.startsWith("sk-ant-")) {
    bad("OPENAI_API_KEY holds an Anthropic key — paste an OpenAI key");
    failures++;
  } else if (process.env.OPENAI_API_KEY?.startsWith("sk-")) {
    ok("OPENAI_API_KEY present");
  } else {
    bad("OPENAI_API_KEY missing or malformed (or set MOCK_LLM=1 to rehearse offline)");
    failures++;
  }

  console.log(`\n${bold("Connectivity")}`);
  try {
    await langfuse.api.health.health();
    ok("Langfuse API reachable and credentials accepted");
  } catch (error) {
    bad(`Cannot reach Langfuse: ${error instanceof Error ? error.message : error}`);
    failures++;
  }

  console.log(`\n${bold("Prompt")}`);
  try {
    // The raw API client rather than `prompt.get`: a pre-flight wants a plain
    // existence check, with no cache, no in-code fallback masking the answer,
    // and no SDK error logging on the 404 we are deliberately testing for.
    const prompt = await langfuse.api.prompts.get(PROMPT_NAME, {
      label: PRODUCTION_LABEL,
    });
    ok(`"${PROMPT_NAME}" v${prompt.version} carries label "${PRODUCTION_LABEL}"`);
    console.log(dim(`       commit: ${prompt.commitMessage ?? "(none)"}`));
    const model = (prompt.config as { model?: string } | null)?.model;
    if (model) console.log(dim(`       model:  ${model}`));
  } catch (error) {
    bad(`No prompt labelled "${PRODUCTION_LABEL}". Run: npm run seed`);
    if (process.env.DEBUG) console.log(dim(String(error)));
    failures++;
  }

  console.log(`\n${bold("Dataset")}`);
  try {
    const dataset = await langfuse.dataset.get(DATASET_NAME);
    if (dataset.items.length === 0) {
      bad(`Dataset "${DATASET_NAME}" is empty. Run: npm run seed`);
      failures++;
    } else {
      ok(`Dataset "${DATASET_NAME}" has ${dataset.items.length} golden cases`);
    }
  } catch {
    bad(`Dataset "${DATASET_NAME}" not found. Run: npm run seed`);
    failures++;
  }

  console.log();
  if (failures === 0) {
    console.log(`${green("All checks passed.")} You are ready to present.\n`);
    return 0;
  }
  console.log(`${red(`${failures} check(s) failed.`)} Fix these before presenting.\n`);
  return 1;
});
