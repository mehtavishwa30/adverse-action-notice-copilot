import "../instrumentation.js";
import fs from "node:fs";
import { generateNotice } from "../notice.js";
import { LANGFUSE_BASE_URL, PRODUCTION_LABEL } from "../env.js";
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
 * Act 1 — generate one notice through the managed prompt.
 *
 * The badge at the top is the point: the application reports which prompt
 * version served the request. Move the label in the Langfuse UI and run this
 * again; the number changes with no deploy and no restart.
 */
await main(async () => {
  const args = parseArgs();
  const caseId = typeof args.case === "string" ? args.case : undefined;
  const label = typeof args.label === "string" ? args.label : PRODUCTION_LABEL;
  const version = typeof args.version === "string" ? Number(args.version) : undefined;

  const cases = JSON.parse(fs.readFileSync("data/cases.json", "utf8")) as ApplicationCase[];
  const appCase = caseId ? cases.find((c) => c.applicationId === caseId) : cases[0];

  if (!appCase) {
    console.error(
      `Unknown case "${caseId}". Available: ${cases.map((c) => c.applicationId).join(", ")}`,
    );
    return 1;
  }

  heading(`Adverse action notice — ${appCase.applicationId}`);

  const result = await generateNotice({ appCase, label, version });

  // --- which prompt served this -------------------------------------------
  const source = version !== undefined ? `pinned v${version}` : `label "${label}"`;
  console.log(
    `\n  ${bold("served by")}  prompt ${bold(`v${result.promptVersion}`)} ` +
      `${dim(`(${source}; labels: ${result.promptLabels.join(", ") || "none"})`)}`,
  );
  if (result.promptCommitMessage) {
    console.log(`  ${dim(`commit     ${result.promptCommitMessage}`)}`);
  }
  console.log(`  ${dim(`model      ${result.model}`)}`);
  if (result.usedFallback) {
    console.log(
      `  ${red("WARNING")}    served the in-code fallback prompt — Langfuse was unreachable.`,
    );
  }

  // --- the letter ----------------------------------------------------------
  console.log(`\n${bold("Notice")}`);
  console.log(dim("".padEnd(72, "-")));
  console.log(result.notice);
  console.log(dim("".padEnd(72, "-")));

  // --- the guardrails that ran on this request ----------------------------
  console.log(`\n${bold("Compliance checks")} ${dim("(these run on every request, not just in evals)")}`);
  table(
    ["check", "score", "detail"],
    result.checks.map((c) => [
      c.value >= 0.999 ? green(c.name) : red(c.name),
      scoreColor(c.value),
      dim(c.comment.length > 76 ? `${c.comment.slice(0, 73)}...` : c.comment),
    ]),
  );

  const headline = result.complianceScore;
  console.log(
    `\n  ${bold("compliance_score")}  ${scoreColor(headline)}  ` +
      (headline >= 0.999
        ? green("all checks passed")
        : red("NOT shippable — at least one check failed")),
  );

  if (result.traceId) {
    console.log(
      `\n  ${blue("trace")}  ${LANGFUSE_BASE_URL}/trace/${result.traceId}\n` +
        dim(`         the generation is linked to prompt v${result.promptVersion}, so this ` +
          `score rolls up\n         into that version's Metrics tab.\n`),
    );
  }

  if (headline < 0.999) {
    console.log(
      `${yellow("This is the prompt that is live today.")} Nobody had scored it before now.\n` +
        `Next: ${bold("npm run experiment")} to see it across all 8 golden cases.\n`,
    );
  }
});
