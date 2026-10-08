# Adverse Action Notice Copilot

**A starter-kit for treating LLM prompts as governed, deployable artifacts — built on [Langfuse](https://langfuse.com) Prompt Management, in a regulated financial-services workflow.**

The demo app generates ECOA / Regulation B adverse action notices (credit decline
letters). That letter is legally mandated text, so its prompt is not a string in
your codebase — it is production configuration *and* a security control. This kit
shows how to version it, gate it, deploy it by label, and roll it back in one move.

---

## Quickstart

```bash
npm install
cp .env.example .env        # add your Langfuse + OpenAI keys
npm run seed                # publishes prompt v1 + an 8-case golden dataset
npm run doctor              # verifies keys, connectivity, label, dataset
npm run notice              # generate a notice through the managed prompt
```

You need a **[Langfuse](https://cloud.langfuse.com) project** (free tier, or
[self-hosted](https://langfuse.com/self-hosting) — set `LANGFUSE_BASE_URL` and
nothing else changes) and an **[OpenAI API key](https://platform.openai.com/api-keys)**.

> **Use an empty Langfuse project.** `npm run reset` deletes *every version* of
> the `adverse-action-notice` prompt. Point this at a scratch project, never one
> holding prompts you care about.

**No OpenAI key yet?** `MOCK_LLM=1 npm run experiment` runs the whole pipeline
against a deterministic stand-in — no spend, no key. Scores in that mode are
illustrative, not model output.

---

## Get started

| | Command | What you see |
|---|---|---|
| **0** | `npm run legacy` | The prompt as a template literal in the source — and the internal decision record sitting in the model's context with nothing but a sentence guarding it. |
| **1** | `npm run serve` | A live page on `:4321` serving the prompt by label, with a version badge. |
| **2** | `npm run experiment` | Two prompt versions scored across the golden dataset. The gate catches a revision that takes five compliance checks from failing to perfect and starts disclosing an internal risk threshold. |
| **3** | `npm run promote -- --version 3` | Deploy by moving a label. The running server picks it up within the cache TTL — no restart, no deploy. |
| **4** | `npm run propose` | An agent reads production scores, publishes a `candidate` version with a reviewable rationale, runs the same gate — and cannot promote. |

---

## Who this is for

- **Engineers shipping LLM features where the output is regulated** — and
  somebody outside engineering owns the words.
- **Teams with prompt management on the roadmap** who want a working reference
  rather than a blog post.
- **Anyone who has been asked "which prompt was live when we sent that?"** and
  did not have an answer.

You will recognise the problem if: the prompt is a string literal; changing one
regulated sentence needs a deploy; nobody has ever scored the prompt that is
live; rollback means a hotfix branch; or an agent is about to get write access to
something that behaves like a security control.

**Assumed knowledge:** TypeScript and Node 20+. No Langfuse experience needed —
the code is commented for first contact.

---

## What you actually get

Four Langfuse capabilities, each doing one job.

| Capability | What it buys you | Where to look |
|---|---|---|
| **Versions + labels** | `production` is a pointer. Promoting is repointing it; rollback is repointing it back. The app reads a label and never knows a version number. | `src/notice.ts` |
| **Config with the prompt** | Model, parameters *and* the compliance policy are versioned together, so promoting a prompt promotes the guardrail it was tested against. | `prompts/*.json` |
| **Prompts linked to traces** | Every score, cost and latency number becomes attributable to a prompt version — which makes "v2 regressed" answerable from production data. | `src/notice.ts` |
| **Datasets + experiments** | The gate. A version may carry `production` only at a 100% pass rate, enforced in `promote` *and* in CI. | `src/evaluators.ts` |

The serving path contains no prompt text, no model name and no thresholds:

```ts
const prompt = await langfuse.prompt.get("adverse-action-notice", {
  type: "chat",
  label: "production",          // the deployment pointer
  cacheTtlSeconds: 60,          // cached in-process; the hot path is a map lookup
  fallback: FALLBACK_MESSAGES,  // Langfuse down + cold cache != outage
});

const policy   = policyFromPromptConfig(prompt.config);  // guardrails ride along
const settings = settingsFromConfig(prompt.config);      // model, tokens, effort
const messages = prompt.compile(promptVariables(appCase));
```

A missing label is a `404`, never a silent fallback — so a typo fails loudly
instead of serving the wrong regulated text.

---

## How it is wired

```
prompts/*.json          prompt versions as reviewable seeds (git reviews, Langfuse deploys)
data/golden-cases.json  8 declined applications that gate every change
src/
  notice.ts             >> THE SERVING PATH — read this first
  evaluators.ts         deterministic checks + one LLM judge + the run-level gate
  domain/
    compliance.ts       >> THE CHECKS — runtime guardrails, evals and CI, one source
    types.ts            ApplicationCase, ReasonCode, CreditScoreDisclosure
  llm.ts                OpenAI Responses API call + the MOCK_LLM stand-in
  instrumentation.ts    OpenTelemetry + LangfuseSpanProcessor, with a PII mask hook
  cli/                  one file per act of the walkthrough
```

Two files carry the idea. **`src/notice.ts`** is notable for what it does *not*
contain. **`src/domain/compliance.ts`** is called from three places — every
production request, every experiment item, and CI — so there is only ever one
definition of "compliant".

<details>
<summary><strong>All commands</strong></summary>

```
npm run doctor                          pre-flight: keys, connectivity, label, dataset
npm run seed                            create the prompt and the golden dataset
npm run reset -- --yes                  delete all versions, republish v1 (destructive)

npm run legacy                          the hardcoded "before" state
npm run notice                          generate one notice (--case, --version, --label)
npm run serve                           live page on :4321 (--port)

npm run draft -- optimised              publish v2, the plausible-but-broken fix
npm run draft -- compliant              publish v3, the correct fix
npm run draft -- --file prompts/x.json  publish any prompt file

npm run experiment                      score production + candidate (--versions 1,2,3)
npm run promote -- --version 3          run the gate, then move the production label
npm run promote -- --version 1 --force  rollback, skipping the gate
npm run versions                        audit view: versions, labels, commit messages

npm run propose                         agent proposes a revision (--hours, --no-gate)
npm run ci -- --label candidate         the same gate, with an exit code
npm run typecheck
```

</details>

---

## The compliance checks

Nine checks: six deterministic, and three more from a *single* LLM judge call.
Reach for a judge only where determinism runs out — an all-judge suite is slow,
costly and non-reproducible; an all-code suite cannot catch invention.

| Check | Kind | Catches |
|---|---|---|
| `reason_code_fidelity` | code | Approved reason disclosures paraphrased or dropped |
| `required_disclosures` | code | Missing ECOA notice or regulator contact block |
| `no_prohibited_language` | code | Implied reconsideration, guarantees, invitations to reapply |
| `no_internal_leakage` | code | Anything on the versioned `neverDisclose` manifest reaching the customer |
| `fcra_score_disclosure` | code | Missing score / range / source / date when a credit score drove the decision |
| `plain_language` | code | Letter over the policy's word ceiling |
| `no_invented_reasons` | judge | A reason stated that was never in the decision record |
| `no_implied_commitments` | judge | Language implying review, reconsideration or a future outcome |
| `tone` | judge | Sales language, blame, or false sympathy in a decline letter |

`reason_code_fidelity` is graded, not binary, so dropping one of three reasons
reads as `0.67` and you can see how bad a regression is.

---

## Customising it for your own use case

The kit is built to be forked. In rough order of value:

**1. Replace the checks.** `src/domain/compliance.ts` is the highest-value file
to adapt — it *is* the gate. Write one function per requirement your regulator
actually imposes. Keep them deterministic wherever the question is literal ("is
this exact disclosure present?") and reserve the judge for what code genuinely
cannot answer ("did it invent a reason?"). Add every new check name to
`CHECK_NAMES` so the agent reads its own signal and not another app's.

**2. Replace the domain.** `src/domain/types.ts` and `data/*.json` define your
case shape. `promptVariables()` in `src/notice.ts` is the seam that maps a case
onto template variables — change the shape on the left and the templates in
`prompts/` follow.

**3. Build the dataset from real traffic.** Replace `data/golden-cases.json` with
cases you have actually seen. In the Langfuse UI you can send a production trace
straight to a dataset, which is the fastest honest way to build one: every
incident becomes a permanent regression test. Twenty real cases beat two hundred
synthetic ones.

**4. Move your secrets out of the prompt.** Enumerate what must never reach a
customer in `config.policy.neverDisclose`. Then ask the harder question this demo
is built around: does the model need that value in its context *at all*? If not,
resolve it in code and the check becomes a backstop rather than the only control.

**5. Wire `npm run ci` into your pipeline.** See
[`.github/workflows/prompt-gate.yml`](./.github/workflows/prompt-gate.yml). Its
`workflow_dispatch` trigger lets Compliance re-run the gate from the Actions tab
after editing a prompt in the Langfuse UI, with no commit involved.

### It adapts cleanly to

KYC / CDD narratives · suitability and advice letters · complaint-handling
responses · collections communications · SAR narrative drafting · credit memo
summaries · claims decision letters · internal credit-policy Q&A.

The pattern holds wherever **the words are regulated and someone outside
engineering owns them.**

### Scaling beyond the demo

- **Multi-jurisdiction:** labels are not limited to environments. `prod-us`,
  `prod-uk`, `prod-eu` can point at different versions of the same prompt, each
  with its own disclosure rules and config.
- **Protected labels:** on Pro (Teams add-on) / Enterprise / self-hosted EE,
  restrict via RBAC who can move `production` at all.
- **PII:** the `mask` hook in `src/instrumentation.ts` runs in *your* process, so
  redaction happens before any span is exported. Enable with `LANGFUSE_MASK_PII=1`.
- **Agents:** [Langfuse ships an agent skill](https://github.com/langfuse/skills)
  that teaches your coding agent these APIs directly.

---

## What this does not cover

Being explicit, because a starter-kit that overclaims is worse than none.

- **Not legal advice.** The regulatory requirements modelled here are simplified
  for a demo, and the creditor, applicants and reason codes are fictional.
  Validate real notice language with your own compliance function.
- **It does not prevent prompt injection.** That is architecture, least privilege
  and output handling. Prompt management makes your *response* fast and provable:
  which instruction set was live, what it produced, and a revert that is a label
  move. For Hidden Context Exposure specifically it is closer to a direct answer,
  because "what is in the context" is exactly what a prompt version defines.
- **No auth, authorisation, rate limiting or PII storage.** `npm run serve` is a
  demo surface, not a service. Do not expose it.
- **No retrieval, no tools, no multi-turn.** One prompt, one call, one letter —
  deliberately, so the prompt-management mechanics stay visible.
- **The judge is not a compliance sign-off.** Six of the nine checks are
  deterministic code a reviewer can read, and the gate fails on any one of them.
  Keep that ratio.
- **Model behaviour varies.** Judged scores drift between runs; the deterministic
  checks do not. Measured across three runs, `reason_code_fidelity` on v1 came in
  at 0.54, 0.67 and 0.75, while every deterministic check was identical each time.
- **Only the OpenAI Responses API is wired up.** `src/llm.ts` is the single file
  to change for another provider.

---

## Further reading

**Prompt management, in depth**
- [Prompt Management overview](https://langfuse.com/docs/prompt-management/overview) — start here
- [Core concepts / data model](https://langfuse.com/docs/prompt-management/data-model) — text vs chat, variables, composition
- [Version control & labels](https://langfuse.com/docs/prompt-management/features/prompt-version-control) — deployment, rollbacks, protected labels
- [Config](https://langfuse.com/docs/prompt-management/features/config) — versioning model params and policy with the prompt
- [Linking prompts to traces](https://langfuse.com/docs/prompt-management/features/link-to-traces) — the hinge that makes metrics per-version
- [Caching](https://langfuse.com/docs/prompt-management/features/caching) · [guaranteed availability](https://langfuse.com/docs/prompt-management/features/guaranteed-availability) — latency, and the outage path

**Evaluation and the gate**
- [Experiments via SDK](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk)
- [Experiments in CI/CD](https://langfuse.com/docs/evaluation/experiments/experiments-ci-cd)
- [Writing good evaluators](https://langfuse.com/academy/evaluate/writing-evaluators) — read this before adding checks
- [LLM-as-a-judge](https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge) · [code evaluators](https://langfuse.com/docs/evaluation/evaluation-methods/code-evaluators)

**Platform and tooling**
- [Self-hosting](https://langfuse.com/self-hosting) — the answer to most data-residency questions
- [Agent skill](https://langfuse.com/docs/api-and-data-platform/features/agent-skill) · [CLI](https://langfuse.com/docs/api-and-data-platform/features/cli)
- [`llms.txt`](https://langfuse.com/llms.txt) — every docs page as Markdown, for your coding agent

**Regulatory and security context**
- [OWASP Top 10 for LLM Applications](https://genai.owasp.org/llm-top-10/) — `LLM01` Prompt Injection, `LLM08:2026` Hidden Context Exposure
- [12 CFR 1002.9](https://www.ecfr.gov/current/title-12/part-1002/section-1002.9) — Reg B notification requirements ([CFPB version](https://www.consumerfinance.gov/rules-policy/regulations/1002/9/))
- [16 CFR Part 698](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-F/part-698) — FCRA model notice forms

---

## Your next step

Pick the one that matches where you are.

**Just cloned it?** Run the five commands under *See it work*, in order. The one
that matters is `npm run experiment` — watch a prompt revision turn six checks
green and fail anyway. That is the whole argument in thirty seconds.

**Convinced, and want this in your codebase this week?**

1. **Inventory your prompts.** Find every string literal that reaches a customer
   or a regulator. Most teams are surprised by the count.
2. **Write down what they must never disclose.** That list is your
   `neverDisclose` manifest, and you almost certainly do not have one yet.
3. **Move one prompt** — your highest-risk one — into Langfuse behind a
   `production` label. One prompt, not all of them.
4. **Build a ten-case dataset** from real traffic, including the two cases that
   have already embarrassed you.
5. **Put the gate in CI and make it required.** The day it blocks a merge is the
   day this stops being a demo.

**Evaluating Langfuse for a regulated workload?** You will be asked three
questions: where does the data live
([self-hosting](https://langfuse.com/self-hosting), or EU/US/JP/HIPAA regions),
who can change production text
([protected labels](https://langfuse.com/docs/prompt-management/features/prompt-version-control#protected-prompt-labels)),
and what happens when it is down
([fallbacks](https://langfuse.com/docs/prompt-management/features/guaranteed-availability)).
All three have answers, and all three are demonstrated in this repo.

**Adapted it to another regulated surface?** Open an issue or a PR. The checks in
`src/domain/compliance.ts` are the most useful thing to contribute — every
regulated domain needs its own, and they are the part nobody can write for you.
[`CONTRIBUTING.md`](./CONTRIBUTING.md) has the recipe, including the one rule
that matters: a new check needs a golden case that *fails* it, or it is
unfalsifiable.

---

MIT licensed — see [`LICENSE`](./LICENSE). Contributions welcome — see
[`CONTRIBUTING.md`](./CONTRIBUTING.md).
