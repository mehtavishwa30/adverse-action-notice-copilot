# Contributing

Thanks for looking. This is a **starter-kit**, not a library — people fork it and
adapt it rather than depend on it. That shapes what makes a good contribution:
changes that make the pattern clearer or more widely applicable, not ones that
add surface area.

---

## Most useful things to contribute

Roughly in order of value:

**1. Compliance checks for another regulated surface.** This is the big one, and
it is in the README's call to action for a reason: every regulated domain needs
its own checks, and they are the part nobody can write for you. KYC / CDD
narratives, suitability letters, complaint responses, collections comms, SAR
drafting, claims decisions. See [Adding a check](#adding-a-check) below.

**2. Bug fixes.** Especially in `src/domain/compliance.ts` or
`src/evaluators.ts`. A check that passes when it should fail is worse than no
check, so these are high priority.

**3. Model provider adapters.** `src/llm.ts` is the only file that touches a
model SDK. A clean Anthropic / Bedrock / Vertex / Azure path behind the same
`callModel()` signature would be genuinely useful.

**4. Documentation that reduces friction.** If something in the README or the
code comments confused you on first read, that is a bug. Say where you got stuck.

**5. Corrections to the regulatory framing.** The ECOA / Reg B and FCRA
modelling is deliberately simplified. If something is wrong in a way that would
mislead, please open an issue — ideally with a citation.

## Please open an issue before

- Adding a dependency. The kit has seven runtime deps and that is a feature.
- Adding retrieval, tools, or multi-turn conversation. One prompt, one call, one
  letter is deliberate — it keeps the prompt-management mechanics visible.
- Publishing it to npm or restructuring it as a library.
- Adding auth or hardening `npm run serve`. It is a demo surface; the README says
  so. Making it look production-ready invites someone to deploy it.
- Reformatting the whole codebase. There is no linter on purpose; match the
  surrounding style.

---

## Setup

```bash
npm install
cp .env.example .env     # your keys
npm run seed
npm run doctor           # must print "All checks passed."
```

> **Use a scratch Langfuse project.** `npm run reset -- --yes` deletes *every
> version* of the `adverse-action-notice` prompt. Never point this at a project
> holding prompts you care about. A free Langfuse project takes about a minute to
> create and is the right way to work on this.

Node 20+. TypeScript, no build step — everything runs through `tsx`.

**Never commit `.env`.** It is gitignored; keep it that way. If you ever think
you have committed a key, say so in the PR immediately rather than
force-pushing over it — a pushed secret needs rotating, not hiding.

---

## How to verify a change

**There is no test suite.** Being upfront about that: `npm run typecheck` is the
only automated check, and CI runs the eval gate rather than unit tests. So
verification is a short manual recipe. All of it is free:

```bash
npm run typecheck                 # must be clean
MOCK_LLM=1 npm run experiment     # whole pipeline, deterministic stand-in, no spend
npm run legacy                    # needs no keys at all
```

`MOCK_LLM=1` swaps in a deterministic stand-in for the model (`mockNotice` in
`src/llm.ts`), so you can exercise seed → experiment → promote → CI without an
OpenAI key and without cost.

**Know the one trap:** the stand-in and a real model do not score identically.
The stub reads the prompt's instructions and imitates compliance; a real model
does not always behave the same way. Measured example — v2's internal-threshold
leak shows up on **2 of 8** cases under `MOCK_LLM=1` and on **8 of 8** with a
real model. Judged checks also drift between runs (`reason_code_fidelity` on v1
measured 0.54, 0.67 and 0.75 across three runs); the deterministic ones do not.

So: use `MOCK_LLM=1` to prove the plumbing works, and **if your change affects
what a check measures, run it once against a real model before claiming a
score.** Say in the PR which one you used.

---

## Adding a check

The highest-value contribution, and there is a right order:

**1. Write it** in `src/domain/compliance.ts`, returning a `CheckResult`:

```ts
export function checkYourThing(
  notice: string,
  appCase: ApplicationCase,
  policy: CompliancePolicy = DEFAULT_POLICY,
): CheckResult {
  return {
    name: "your_thing",          // snake_case, stable — it becomes a score name
    value: 0,                    // 0..1; prefer binary for violations
    comment: "Why this failed, in words a compliance reviewer can act on.",
  };
}
```

**2. Register it in `runComplianceChecks()`** so it runs on every production
request, every experiment item, and in CI.

**3. Add the name to `CHECK_NAMES`.** This is easy to miss and the failure is
silent: the proposing agent filters production scores to that allowlist, so an
unregistered check is invisible to it.

**4. Add a golden case to `data/golden-cases.json` that your check FAILS.**

This step is not optional, and it is the rule most worth internalising. A check
with no failing case in the dataset is **unfalsifiable** — it can only ever pass,
which looks like coverage and is decoration. This repo shipped exactly that bug
once: `no_internal_leakage` tested for values that were never in the prompt, so
it passed on everything. If you cannot construct a case that fails your check,
the check is probably not measuring anything.

**5. Put the threshold in `config.policy`**, not in the function. Policy is
versioned alongside the prompt text in `prompts/*.json`, which is what stops the
text and the yardstick drifting apart.

**6. Update the checks table in the README.**

### Deterministic or judged?

The test: **if `String.includes` can answer it, it is not a judge question.**

Six of the nine checks are deterministic code, and that ratio is deliberate.
Deterministic checks are cheap, reproducible, and readable by a compliance
officer — which matters more than elegance here. Reserve the LLM judge for
questions determinism structurally cannot reach, like *did the letter invent a
reason that was never in the decision record?*

A PR that adds a judge for something a string match could do will get pushed
back on, kindly.

---

## Conventions

- **One definition of "compliant."** `src/domain/compliance.ts` is called from
  the runtime path, the experiment runner, and CI. Do not add a second,
  parallel notion of correctness.
- **Keep the serving path empty of policy.** `src/notice.ts` contains no prompt
  text, no model name and no thresholds — all of it arrives from the prompt
  version. That is the whole point; please keep it true.
- **Comment the why, not the what.** The code is written for someone meeting
  Langfuse for the first time. If a line encodes a decision, say which decision.
- **Prompt changes go in `prompts/*.json`,** never inline in TypeScript. The
  exception is `src/cli/legacy.ts`, where the hardcoded prompt *is* the point.
- **British or American spelling:** either, just be internally consistent within
  a file.

## Things that will fail review

- A new check with no failing golden case (see above).
- A check whose threshold is hardcoded instead of read from `config.policy`.
- Prompt text added to a `.ts` file outside `legacy.ts`.
- Loosening a check to make a version pass. If a prompt fails the gate, fix the
  prompt.
- `npm run typecheck` failing.

---

## Pull requests

Keep them focused — one check, one fix, one adapter. In the description:

- What changed and why.
- Which verification you ran (`MOCK_LLM=1`, a real model, or both).
- For a new check: the golden case that fails it, and the before/after scores.

Commit messages: a short imperative subject, and a body explaining the reasoning
if the change is not obvious. No required format.

---

## A note on regulatory content

The regulatory requirements in this repo are **simplified for a demo**, and the
creditor, applicants and reason codes are fictional. Contributions that touch
regulatory text are welcome, but:

- Nothing here is legal advice, and contributing does not make you anyone's
  counsel.
- Cite the rule you are modelling where you can (eCFR, CFPB, FCA, etc.).
- Keep real institutions, real customers and real internal policy out of it.
  Everything in this repo is invented, and it should stay that way.

---

## Licensing

By contributing you agree your work is licensed under the
[MIT License](./LICENSE), same as the rest of the project. No CLA.

---

Questions, or not sure whether something is in scope? Open an issue and ask —
that is cheaper than guessing, for both of us.
