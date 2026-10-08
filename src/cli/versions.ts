import "../instrumentation.js";
import { langfuse } from "../langfuse.js";
import { PROMPT_NAME, LANGFUSE_BASE_URL } from "../env.js";
import { main, heading, table, bold, dim, green, yellow, blue } from "./_shared.js";

/**
 * The audit view: every version of the prompt, its labels, and why it exists.
 *
 * This is the answer to "which wording was in force when we wrote to this
 * applicant in March?" — the question the hardcoded version could not answer.
 */
await main(async () => {
  heading(`Prompt "${PROMPT_NAME}" — version history`);

  const meta = await langfuse.api.prompts.list({ name: PROMPT_NAME, limit: 100 });
  const entry = meta.data.find((p) => p.name === PROMPT_NAME);

  if (!entry) {
    console.log(`\n  No prompt named "${PROMPT_NAME}". Run ${bold("npm run seed")} first.\n`);
    return 1;
  }

  // The list endpoint returns metadata; fetch each version for its commit
  // message and config.
  const versions = [...entry.versions].sort((a, b) => b - a);
  const rows: string[][] = [];

  for (const version of versions) {
    const prompt = await langfuse.api.prompts.get(PROMPT_NAME, { version });
    const labels = prompt.labels ?? [];

    const labelCell = labels.length
      ? labels
          .map((l) =>
            l === "production" ? green(l) : l === "candidate" ? yellow(l) : dim(l),
          )
          .join(", ")
      : dim("-");

    const config = (prompt.config ?? {}) as { model?: string };
    const commit = prompt.commitMessage ?? "";

    rows.push([
      bold(`v${version}`),
      labelCell,
      dim(config.model ?? "-"),
      commit.length > 70 ? `${commit.slice(0, 67)}...` : commit || dim("(none)"),
    ]);
  }

  table(["version", "labels", "model", "commit message"], rows);

  console.log(
    `\n  ${dim(`last updated ${new Date(entry.lastUpdatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`)}`,
  );
  console.log(
    `\n  ${dim("production")} = what the application serves right now.\n` +
      `  ${dim("candidate")}  = published, gated, awaiting a human decision.\n`,
  );
  console.log(
    `  Full history, diffs and label changes: ` +
      `${blue(`${LANGFUSE_BASE_URL}`)} -> Prompts -> ${PROMPT_NAME}\n`,
  );
});
