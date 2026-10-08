import fs from "node:fs";
import type { ChatPromptClient } from "@langfuse/client";
import { langfuse } from "../langfuse.js";

/**
 * Publish a prompt version from a JSON file in `prompts/`.
 *
 * Keeping the seeds in git is deliberate: prompts-as-code and prompts-as-managed
 * artifact are not in competition. Git is where a version is *reviewed*; Langfuse
 * is where it is *deployed*, labelled, evaluated and rolled back. The file is the
 * proposal, the Langfuse version is the release.
 */

interface PromptFile {
  name: string;
  type: "chat";
  labels: string[];
  tags?: string[];
  commitMessage?: string;
  prompt: Array<{ role: string; content: string }>;
  config: unknown;
}

export async function createPromptFromFile(path: string): Promise<ChatPromptClient> {
  const spec = JSON.parse(fs.readFileSync(path, "utf8")) as PromptFile;

  return langfuse.prompt.create({
    name: spec.name,
    type: "chat",
    prompt: spec.prompt as never,
    labels: spec.labels,
    tags: spec.tags,
    // The commit message is the audit trail. An unexplained prompt version in a
    // regulated system is a finding waiting to happen.
    commitMessage: spec.commitMessage,
    config: spec.config,
  });
}

// --- CLI -------------------------------------------------------------------
// Only runs when invoked directly, so `seed.ts` can import the helper above.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { main, heading, green, dim, bold, yellow } = await import("./_shared.js");
  const { parseArgs } = await import("./_shared.js");
  await import("../instrumentation.js");

  await main(async () => {
    const args = parseArgs();
    const which = String(args._ ?? args.which ?? "");

    const known: Record<string, string> = {
      optimised: "prompts/v2-optimised.json",
      compliant: "prompts/v3-compliant.json",
      legacy: "prompts/v1-legacy.json",
    };

    const path = known[which] ?? (typeof args.file === "string" ? args.file : undefined);
    if (!path) {
      console.log(`\n${bold("Usage")}  npm run draft -- <optimised|compliant|legacy>`);
      console.log(`       npm run draft -- --file prompts/my-version.json\n`);
      console.log(`${bold("Available")}`);
      for (const [key, value] of Object.entries(known)) {
        console.log(`  ${green(key.padEnd(10))} ${dim(value)}`);
      }
      console.log();
      return 1;
    }

    heading(`Publishing ${path}`);
    const prompt = await createPromptFromFile(path);

    console.log(
      `\n  ${green("created")} "${prompt.name}" ${bold(`v${prompt.version}`)} ` +
        `labels=[${prompt.labels.join(", ")}]`,
    );
    console.log(dim(`          ${prompt.commitMessage ?? "(no commit message)"}`));
    console.log(
      `\n  ${yellow("Not live yet.")} It carries "candidate", not "production".` +
        `\n  Next: ${bold("npm run experiment")} to score it against the golden dataset.\n`,
    );
  });
}
