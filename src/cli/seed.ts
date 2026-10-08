import "../instrumentation.js";
import fs from "node:fs";
import { langfuse } from "../langfuse.js";
import { PROMPT_NAME, DATASET_NAME, LANGFUSE_BASE_URL } from "../env.js";
import { main, heading, green, dim, bold, blue } from "./_shared.js";
import { createPromptFromFile } from "./draft.js";

/**
 * One-time setup: put the legacy prompt under management and publish the
 * golden dataset Compliance will sign off on.
 *
 * Both halves matter. Versioning a prompt without a dataset to judge it against
 * just gives you a tidier way to ship regressions.
 */
await main(async () => {
  heading("Seeding Langfuse");

  // --- 1. The prompt ------------------------------------------------------
  console.log(`\n${bold("Prompt")}`);
  const prompt = await createPromptFromFile("prompts/v1-legacy.json");
  console.log(
    `  ${green("created")} "${prompt.name}" ${bold(`v${prompt.version}`)} ` +
      `labels=[${prompt.labels.join(", ")}]`,
  );
  console.log(dim(`          ${prompt.commitMessage ?? ""}`));

  // --- 2. The golden dataset ---------------------------------------------
  console.log(`\n${bold("Dataset")}`);

  // Create only if absent, so re-running seed is safe without relying on the
  // create endpoint being an upsert.
  const existing = await langfuse.api.datasets
    .get(DATASET_NAME)
    .catch(() => null);

  if (existing) {
    console.log(`  ${dim("exists")}  dataset "${DATASET_NAME}"`);
  } else {
    await langfuse.api.datasets.create({
      name: DATASET_NAME,
      description:
        "Declined applications used to gate every change to the adverse action notice " +
        "prompt. Covers reason-count variation, credit-score and no-score branches, " +
        "numeric disclosure text, and cases that bait the model into offering hope.",
      metadata: { owner: "compliance", regulation: "ECOA / Reg B, FCRA 615(a)" },
    });
    console.log(`  ${green("created")} dataset "${DATASET_NAME}"`);
  }

  interface GoldenItem {
    id: string;
    input: unknown;
    expectedOutput: unknown;
    metadata: unknown;
  }

  const items = JSON.parse(
    fs.readFileSync("data/golden-cases.json", "utf8"),
  ) as GoldenItem[];

  for (const item of items) {
    // Items upsert on `id`, so re-running seed is safe and idempotent.
    await langfuse.api.datasetItems.create({
      datasetName: DATASET_NAME,
      id: item.id,
      input: item.input,
      expectedOutput: item.expectedOutput,
      metadata: item.metadata,
    });
  }
  console.log(`  ${green("upserted")} ${items.length} golden cases`);

  // --- 3. Where to look ---------------------------------------------------
  const projectUrl = `${LANGFUSE_BASE_URL}/project`;
  console.log(`\n${bold("Next")}`);
  console.log(`  1. ${blue("npm run doctor")}      verify everything is wired up`);
  console.log(`  2. ${blue("npm run notice")}      generate a notice on the production prompt`);
  console.log(`  3. ${blue("npm run experiment")}  score the prompt that is live today`);
  console.log(dim(`\n  Prompt and dataset are now visible under ${projectUrl}`));
  console.log(
    dim(`  Prompts -> ${PROMPT_NAME}   |   Datasets -> ${DATASET_NAME}\n`),
  );
});
