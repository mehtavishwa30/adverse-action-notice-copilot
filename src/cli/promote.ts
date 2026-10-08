import "../instrumentation.js";
import { langfuse } from "../langfuse.js";
import { scoreVersion, printComparison } from "./experiment.js";
import {
  PROMPT_NAME,
  PRODUCTION_LABEL,
  PROMPT_CACHE_TTL_SECONDS,
  LANGFUSE_BASE_URL,
} from "../env.js";
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
 * Act 3 — deploy by moving a label.
 *
 * This is the entire deployment mechanism: `production` is a pointer, and
 * promoting is repointing it. No build, no container, no restart. The running
 * application picks the new version up within its prompt cache TTL.
 *
 * The gate is enforced *here*, at the boundary, rather than left to discipline.
 * `--force` exists because incident response sometimes needs it, and because a
 * control plane that cannot be overridden gets worked around instead.
 */
await main(async () => {
  const args = parseArgs();
  const version = typeof args.version === "string" ? Number(args.version) : undefined;
  const force = args.force === true;
  const label = typeof args.label === "string" ? args.label : PRODUCTION_LABEL;

  if (version === undefined || !Number.isFinite(version)) {
    console.log(`\n${bold("Usage")}`);
    console.log(`  npm run promote -- --version 3`);
    console.log(`  npm run promote -- --version 3 --label staging`);
    console.log(`  npm run promote -- --version 1 --force   ${dim("# rollback, skips the gate")}\n`);
    console.log(`  See current state with ${bold("npm run versions")}.\n`);
    return 1;
  }

  heading(`Promote v${version} to "${label}"`);

  // --- the gate -----------------------------------------------------------
  if (force) {
    console.log(
      `\n  ${yellow("--force")} the gate will not be run. ` +
        `${dim("Use this for rollback and incident response.")}`,
    );
  } else {
    console.log(`\n${dim(`Running the compliance gate on v${version} before promoting...`)}`);
    const summary = await scoreVersion(version, "promotion-gate");
    printComparison([summary]);

    if (summary.shippableRate < 0.999) {
      console.log(
        `\n  ${red("Promotion refused.")} v${version} passed ` +
          `${Math.round(summary.shippableRate * summary.itemCount)}/${summary.itemCount} ` +
          `golden cases; promotion requires all of them.`,
      );
      console.log(
        dim(
          `\n  This is the gate doing its job. Inspect the failures, fix the prompt,\n` +
            `  publish a new version, and try again.\n`,
        ),
      );
      if (summary.datasetRunUrl) console.log(`  ${blue(summary.datasetRunUrl)}\n`);
      return 1;
    }

    console.log(`\n  ${green("Gate passed.")} All ${summary.itemCount} golden cases clean.`);
  }

  // --- move the label -----------------------------------------------------
  const previous = await langfuse.prompt
    .get(PROMPT_NAME, { type: "chat", label, cacheTtlSeconds: 0 })
    .catch(() => null);

  await langfuse.prompt.update({
    name: PROMPT_NAME,
    version,
    newLabels: [label],
  });

  console.log(`\n${bold("Deployed")}`);
  if (previous && !previous.isFallback && previous.version !== version) {
    console.log(
      `  "${label}"  v${previous.version} ${dim("->")} ${green(`v${version}`)}`,
    );
  } else {
    console.log(`  "${label}"  ${dim("->")} ${green(`v${version}`)}`);
  }

  console.log(
    `\n  Running instances pick this up within their prompt cache TTL ` +
      `(${PROMPT_CACHE_TTL_SECONDS}s here).\n  ${dim("No deploy. No restart. No code change.")}`,
  );
  console.log(
    `\n  Verify:  ${bold("npm run notice")}   ${dim("# the version badge should now read v" + version)}`,
  );
  console.log(
    `  Audit:   ${blue(`${LANGFUSE_BASE_URL}`)} -> Prompts -> ${PROMPT_NAME} -> Versions\n` +
      dim(`           every version, its commit message, who set which label, and when.\n`),
  );
});
