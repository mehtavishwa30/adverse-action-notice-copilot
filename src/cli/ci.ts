import "../instrumentation.js";
import { fetchPrompt } from "../notice.js";
import { scoreVersion, printComparison } from "./experiment.js";
import { langfuse } from "../langfuse.js";
import { PROMPT_NAME, PRODUCTION_LABEL, CANDIDATE_LABEL } from "../env.js";
import { main, parseArgs, heading, bold, dim, green, red } from "./_shared.js";

/**
 * Act 5 — the same gate, in CI.
 *
 * Nothing here is new. It is `scoreVersion` plus a non-zero exit code, which is
 * the whole point: the check a compliance officer clicks through in the UI and
 * the check that blocks a merge are the same code, the same dataset and the same
 * thresholds. There is no second, drifting definition of "compliant".
 *
 * Wire it into a workflow:
 *
 *   - name: Reg B prompt gate
 *     run: npm run ci -- --label candidate --min-shippable 1.0
 *     env:
 *       LANGFUSE_PUBLIC_KEY: ${{ secrets.LANGFUSE_PUBLIC_KEY }}
 *       LANGFUSE_SECRET_KEY: ${{ secrets.LANGFUSE_SECRET_KEY }}
 *       OPENAI_API_KEY:      ${{ secrets.OPENAI_API_KEY }}
 */
await main(async () => {
  const args = parseArgs();
  const label = typeof args.label === "string" ? args.label : CANDIDATE_LABEL;
  const minShippable =
    typeof args["min-shippable"] === "string" ? Number(args["min-shippable"]) : 1.0;
  const compareToProduction = !args["no-baseline"];

  heading(`CI gate — label "${label}", threshold ${minShippable}`);

  let target;
  try {
    target = await langfuse.prompt.get(PROMPT_NAME, {
      type: "chat",
      label,
      cacheTtlSeconds: 0,
    });
  } catch {
    console.log(
      `\n  ${red("FAIL")} no prompt version carries the label "${label}".\n` +
        dim(`       Langfuse does not silently fall back to production, so a typo\n` +
          `       or an unassigned label fails here rather than shipping the wrong text.\n`),
    );
    return 1;
  }

  if (target.isFallback) {
    console.log(`\n  ${red("FAIL")} could not reach Langfuse; refusing to pass the gate blind.\n`);
    return 1;
  }

  console.log(
    `\n  target    v${target.version} ${dim(`(${target.commitMessage ?? "no commit message"})`)}`,
  );

  const summaries = [];

  if (compareToProduction) {
    const live = await fetchPrompt({ label: PRODUCTION_LABEL });
    if (!live.isFallback && live.version !== target.version) {
      console.log(`  baseline  v${live.version} ${dim(`(label "${PRODUCTION_LABEL}")`)}`);
      summaries.push(await scoreVersion(live.version, "ci-baseline"));
    }
  }

  summaries.push(await scoreVersion(target.version, "ci-gate"));
  printComparison(summaries);

  const result = summaries.at(-1)!;
  const passed = result.shippableRate >= minShippable;
  const cases = Math.round(result.shippableRate * result.itemCount);

  console.log();
  if (passed) {
    console.log(
      `  ${green("PASS")} v${result.version} cleared every check on ` +
        `${cases}/${result.itemCount} golden cases.\n`,
    );
    return 0;
  }

  console.log(
    `  ${red("FAIL")} v${result.version} passed ${cases}/${result.itemCount} cases ` +
      `(shippable ${result.shippableRate.toFixed(2)} < ${minShippable}).`,
  );
  if (result.datasetRunUrl) {
    console.log(`       ${dim(result.datasetRunUrl)}`);
  }
  console.log(
    dim(`\n       A regulated prompt change is now as hard to ship broken as a\n` +
      `       code change. That is the whole idea.\n`),
  );
  return 1;
});
