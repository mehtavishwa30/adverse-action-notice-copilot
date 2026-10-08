import fs from "node:fs";
import { heading, red, yellow, dim, bold } from "./_shared.js";
import type { ApplicationCase } from "../domain/types.js";
import { INSTITUTION } from "../domain/institution.js";

/**
 * Act 0 — the "before" state. This file is the villain of the walkthrough.
 *
 * The prompt is a template literal in the application source. That single fact
 * produces every problem the rest of this repo solves:
 *
 *   - Changing one regulated sentence requires a code change, a review, a build
 *     and a deploy. Compliance cannot do it; engineering must be interrupted.
 *   - There is no version history for the prompt specifically, no commit message
 *     explaining *why* the wording changed, and no way to see which wording was
 *     in force on the day a given letter was sent.
 *   - Rollback is another deploy.
 *   - The model and its parameters are hardcoded next to the text, so switching
 *     models is also a deploy.
 *   - Nobody has ever scored it. It has been in production for eight months.
 *
 * Nothing here is strawman code. This is what almost every LLM feature looks
 * like on day one, and it works fine right up until the wording is regulated.
 */

const LEGACY_SYSTEM_PROMPT = `You write adverse action notices for ${INSTITUTION.name}, a US consumer lender.

Write in a warm, human tone. Keep the letter short and easy to read. Summarise why
the application could not be approved, and leave the applicant feeling positive
about the relationship.

Always include this paragraph near the end:

The Federal Equal Credit Opportunity Act prohibits creditors from discriminating
against credit applicants on the basis of race, color, religion, national origin,
sex, marital status, age, because all or part of the applicant's income derives
from any public assistance program, or because the applicant has in good faith
exercised any right under the Consumer Credit Protection Act.

Then give the regulator contact details:
${INSTITUTION.regulator.name}
${INSTITUTION.regulator.address}

Close by encouraging the applicant to reapply once their circumstances have improved.

Output the letter body only. No subject line, no markdown, no commentary.`;

// Model choice and parameters, also hardcoded, also needing a deploy to change.
const MODEL = "gpt-6.1-sol";
const MAX_OUTPUT_TOKENS = 2000;

/** Locate a declaration in this very file, so the pointers below never go stale. */
function lineOf(needle: string): string {
  const lines = fs.readFileSync("src/cli/legacy.ts", "utf8").split("\n");
  const index = lines.findIndex((l) => l.startsWith(needle));
  return index === -1 ? "?" : String(index + 1);
}

// Act 0 deliberately imports nothing from Langfuse. There is nothing to import:
// the prompt is in the source file, which is the entire problem.
{
  heading("Act 0 — the prompt as it exists today");

  const cases = JSON.parse(fs.readFileSync("data/cases.json", "utf8")) as ApplicationCase[];
  const appCase = cases[0]!;

  console.log(`\n${bold("Where the regulated text lives")}`);
  console.log(
    `  ${dim(`src/cli/legacy.ts:${lineOf("const LEGACY_SYSTEM_PROMPT")}`)}  ` +
      `a template literal in the application source`,
  );
  console.log(
    `  ${dim(`src/cli/legacy.ts:${lineOf("const MODEL")}`)}  ` +
      `model "${MODEL}", max_output_tokens ${MAX_OUTPUT_TOKENS}`,
  );

  console.log(`\n${bold("The prompt")}`);
  console.log(
    LEGACY_SYSTEM_PROMPT.split("\n")
      .map((line) => `  ${dim(line)}`)
      .join("\n"),
  );

  console.log(`\n${bold("The 4pm message from Legal")}`);
  console.log(
    [
      "  LEGAL-4471 — Reg B review finding. Effective immediately:",
      "    1. Decline notices must state the specific principal reasons",
      "       verbatim as approved. Paraphrasing is a violation.",
      "    2. Remove all language inviting the applicant to reapply.",
      "    3. The full regulator block must appear on every notice.",
    ].join("\n"),
  );

  // The second villain, and the one the room will not have thought about.
  console.log(`\n${bold("What else is in the context window")}`);
  console.log(
    [
      `  The model is handed the whole decision record for ${appCase.applicationId},`,
      "  because the letters read better with it:",
      "",
      `    Scorecard:         ${appCase.internal.modelVersion}`,
      `    Risk score:        ${appCase.internal.riskScore}`,
      `    Decline threshold: ${appCase.internal.decisionThreshold}`,
    ].join("\n"),
  );
  console.log(
    `\n  ${red("!")} Nothing in the prompt above says not to repeat any of it.`,
  );
  console.log(
    dim(
      "\n  OWASP calls this Hidden Context Exposure (LLM08:2026): non-user-facing\n" +
        "  content assembled into a model's context. Once it is in there, the only\n" +
        "  control between an internal threshold and a customer's mailbox is a\n" +
        "  sentence in the prompt.",
    ),
  );

  console.log(`\n${bold("What it takes to change one sentence")}`);
  const steps = [
    "Compliance files a ticket",
    "An engineer picks it up, edits the string literal",
    "Pull request, review, CI",
    "Deploy to staging, then production",
    "Hope nothing else regressed — there is no eval suite",
  ];
  steps.forEach((step, i) => console.log(`  ${red(String(i + 1))}. ${step}`));

  console.log(`\n${bold("And the questions nobody can answer")}`);
  for (const q of [
    "Which wording was in force when we wrote to this applicant in March?",
    "Who approved this sentence, and why?",
    "Did last week's edit make the letters better or worse?",
    "Has this prompt ever printed the decline threshold to a customer?",
    "A disclosure is live right now. How fast can we stop it?",
  ]) {
    console.log(`  ${yellow("?")} ${q}`);
  }

  console.log(
    `\n${dim(`Case on deck: ${appCase.applicationId} (${appCase.reasonCodes.length} reason codes, ` +
      `credit score ${appCase.creditScore ? "used" : "not used"})`)}`,
  );
  console.log(`\n  Next: ${bold("npm run seed")} — move the prompt out of the binary.\n`);
}
