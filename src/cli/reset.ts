import "../instrumentation.js";
import fs from "node:fs";
import { langfuse } from "../langfuse.js";
import {
  PROMPT_NAME,
  DATASET_NAME,
  PRODUCTION_LABEL,
  LANGFUSE_BASE_URL,
} from "../env.js";
import { createPromptFromFile } from "./draft.js";
import {
  main,
  parseArgs,
  heading,
  bold,
  dim,
  green,
  red,
  yellow,
  blue,
} from "./_shared.js";

/**
 * Put the demo back to a clean, pre-talk state.
 *
 * This matters more than it looks. After two rehearsals your project is at v7
 * with `production` pointing at v5, and a script that says "v1, v2, v3" no
 * longer describes what the audience sees. Reset deletes every version of the
 * prompt and republishes the legacy one, so Act 0 starts where it should.
 *
 * Destructive, and guarded accordingly: it needs `--yes`, it names the host and
 * prompt it is about to touch, and it refuses to run against a tracing
 * environment that looks like production.
 *
 * Run this BEFORE `npm run serve`. A running server holds the old prompt in its
 * in-process cache for up to the TTL, and will happily serve a version you just
 * deleted.
 */
await main(async () => {
  const args = parseArgs();
  const confirmed = args.yes === true;
  const environment = process.env.LANGFUSE_TRACING_ENVIRONMENT ?? "demo";

  heading("Reset the demo to a clean state");

  console.log(`\n${bold("About to modify")}`);
  console.log(`  host        ${LANGFUSE_BASE_URL}`);
  console.log(`  prompt      ${PROMPT_NAME}  ${red("(all versions deleted)")}`);
  console.log(`  dataset     ${DATASET_NAME}  ${dim("(items re-upserted, not deleted)")}`);
  console.log(`  environment ${environment}`);

  // Cheap insurance against someone running this against a real project.
  if (/^(prod|production|live)$/i.test(environment)) {
    console.log(
      `\n  ${red("Refusing to run.")} LANGFUSE_TRACING_ENVIRONMENT is "${environment}".\n` +
        `  ${dim("This deletes prompt versions. Point it at a demo project first.")}\n`,
    );
    return 1;
  }

  // --- what is there now? -------------------------------------------------
  const before = await langfuse.api.prompts
    .list({ name: PROMPT_NAME, limit: 100 })
    .then((r) => r.data.find((p) => p.name === PROMPT_NAME))
    .catch(() => undefined);

  if (before) {
    const versions = [...before.versions].sort((a, b) => a - b);
    console.log(
      `\n${bold("Current state")}\n  ${versions.length} version(s): ` +
        `v${versions.join(", v")}   labels: [${before.labels.join(", ")}]`,
    );
  } else {
    console.log(`\n${bold("Current state")}\n  ${dim("no prompt found — nothing to delete")}`);
  }

  if (!confirmed) {
    console.log(
      `\n  ${yellow("Dry run.")} Re-run with ${bold("--yes")} to actually reset:\n` +
        `  ${bold("npm run reset -- --yes")}\n`,
    );
    return 0;
  }

  // --- delete every version ----------------------------------------------
  if (before) {
    // No version and no label means "all versions of this prompt".
    await langfuse.prompt.delete(PROMPT_NAME);
    console.log(`\n  ${green("deleted")}  all versions of "${PROMPT_NAME}"`);
  }

  // --- republish v1 -------------------------------------------------------
  const prompt = await createPromptFromFile("prompts/v1-legacy.json");
  console.log(
    `  ${green("created")}  "${prompt.name}" ${bold(`v${prompt.version}`)} ` +
      `labels=[${prompt.labels.join(", ")}]`,
  );

  // --- dataset ------------------------------------------------------------
  const existing = await langfuse.api.datasets.get(DATASET_NAME).catch(() => null);
  if (!existing) {
    await langfuse.api.datasets.create({
      name: DATASET_NAME,
      description:
        "Declined applications used to gate every change to the adverse action " +
        "notice prompt.",
      metadata: { owner: "compliance", regulation: "ECOA / Reg B, FCRA 615(a)" },
    });
  }

  interface GoldenItem { id: string; input: unknown; expectedOutput: unknown; metadata: unknown }
  const items = JSON.parse(
    fs.readFileSync("data/golden-cases.json", "utf8"),
  ) as GoldenItem[];
  for (const item of items) {
    await langfuse.api.datasetItems.create({
      datasetName: DATASET_NAME,
      id: item.id,
      input: item.input,
      expectedOutput: item.expectedOutput,
      metadata: item.metadata,
    });
  }
  console.log(`  ${green("upserted")} ${items.length} golden cases`);

  // --- verify, and tell the presenter their numbers -----------------------
  const live = await langfuse.api.prompts
    .get(PROMPT_NAME, { label: PRODUCTION_LABEL })
    .catch(() => null);

  console.log(`\n${bold("Verify")}`);
  if (!live) {
    console.log(`  ${red("fail")}  no version carries "${PRODUCTION_LABEL}"`);
    return 1;
  }
  console.log(`  ${green("ok")}    "${PRODUCTION_LABEL}" -> v${live.version}`);

  console.log(`\n${bold("Your version numbers for this run")}`);
  if (prompt.version === 1) {
    console.log(`  ${green("v1")} legacy (live)   ${dim("->")} v2 optimised   ${dim("->")} v3 compliant`);
    console.log(dim(`  The walkthrough's numbers match. Nothing to adjust.`));
  } else {
    // Langfuse may not reuse version numbers after a delete. Say so loudly
    // rather than let the presenter discover it mid-talk.
    const base = prompt.version;
    console.log(
      `  ${yellow("Heads up:")} this project did not restart numbering at 1.\n` +
        `  ${bold(`v${base}`)} legacy (live)   ${dim("->")} v${base + 1} optimised   ` +
        `${dim("->")} v${base + 2} compliant`,
    );
    console.log(
      dim(
        `\n  Read the walkthrough's v1/v2/v3 as v${base}/v${base + 1}/v${base + 2},\n` +
          `  and use --version ${base + 2} where it says --version 3.`,
      ),
    );
  }

  console.log(`\n${bold("Next")}`);
  console.log(`  1. ${blue("npm run doctor")}   confirm all checks pass`);
  console.log(`  2. ${blue("npm run serve")}    start it AFTER this reset, not before`);
  console.log(dim(`\n  ${LANGFUSE_BASE_URL} -> Prompts -> ${PROMPT_NAME}\n`));
});
