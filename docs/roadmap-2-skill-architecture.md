# Roadmap 2 — the skill architecture

**Own session. Own branch** (do NOT continue on
`claude/roadmap-plan-8e52ff` — owner's instruction 2026-07-26; suggest
`claude/skills-architecture`).
Sister roadmap: `docs/roadmap-1-agent-finishes-the-job.md`.

Design of record with research, sources and the full phase plan:
`docs/skill-first-architecture-plan.md`. This file is the STATUS — what is done,
what is not, and where to pick up.

---

## The decision, settled — do not re-open it

The owner asked for skills with their own system prompt, unaffected by other
rules. That is **subagent** semantics, not skill semantics. The answer:

> **The skill FILE is the knowledge. The skill RUNNER is the isolation.**

And the enforcement is never the wording:

> **A prompt rule is a request. An absent tool is a guarantee.**

Everything that has held in this codebase — listen mode, chat modes, "don't ask
me", the read-only audit skill — held because a tool was withheld.

## Authority ladder (fixed)

```
1. Safety, permissions, sandbox           ← no skill touches these
2. Money, approvals, publish gates        ← enforced in CODE, not in text
3. ALMA invariants (alma-base)
4. Boss's instruction this turn
5. The selected skill's workflow          ← this is what a skill controls
```

A skill displaces the general behavioural prompt. It never displaces the gates.

---

## Done (SK-0 … SK-5), all measured

| Phase | Result |
|---|---|
| **SK-0** measure | Router **61%** on his real messages. And the finding that explains everything: the loader only serves `status: active` skills and **15 of the 16 were `draft`** — flipping the engine on would have exposed exactly one skill. They were never offered, so they never did anything. |
| **SK-1** eval harness | 5 dimensions (routing / procedure / safety / honesty / completion). Safety and honesty are pass-fail, never a curve. `compareToBaseline()` blocks a skill if ANY scenario regressed, even when the average improved — the research found 13 of 87 tasks got worse with skills. Validated by replaying this week's real failures. |
| **SK-2** format v2 + linter | `alma-base` holds the invariants once (`implicit: false`, inherited not selected). Linter verdict on our own skills: **79 findings, 12 errors** — 16 of 16 descriptions say WHAT but not WHEN, which is the cleanest explanation of the 61%. Two thresholds calibrated on real data, not guessed. |
| **SK-3** router | **61% → 78%, false triggers 1 → 0.** Filter → deterministic rules → model only for what is left. Fix-vs-audit never reaches a model. Pin per conversation (a 5k-token skill re-picked每 turn destroys the prompt cache). Trace stored: layer, reason, runner-up. |
| **SK-4** enforcement | Tool allowlist from the skill; dependencies checked before step 0; `done:` gate against real tool records. `find_tool`/`ask_user`/`save_memory` always survive so a skill can never be trapped. |
| **SK-5** the three SEO skills | `seo-auditing-own-site` (read-only, holds no write tool), `seo-fixing-own-site` (writes via approval card, has its own `SYSTEM.md`), `seo-fixing-client-site` (no DB, no login). Zero lint findings. Originals stay `draft` — promoted one at a time with evals, never in a batch. |

### Did the skill actually help? — live, measured

| | no skill | with `seo-fixing-own-site` |
|---|---|---|
| turn 1 | 1m 5s · 9 steps · $0.2743 | 41s · 5 steps · $0.0098 |
| batch staged | **1 product** | **10**, labelled "ব্যাচ ১" |
| needed a nudge not to stop | yes | no |
| wasted a call on placeholder URLs | yes | no |

The decisive moment was not the numbers. Asked to fix alt text, the agent
verified a live page first and wrote: *"the **skill warned me about this exact
situation**… zero of them are alt text problems"* — reaching in under a minute
the conclusion that had cost me a morning of hand-checking, because that
morning's finding was in `traps.md`. Then it redirected to the real work.

**Verdict: helped.** Honest caveat: part of the cost gap is DeepSeek vs Sonnet,
so the single-variable claim is the behaviour, not the 28× price.

---

## SK-7 — `isolation: subagent` (2026-07-27, branch `claude/skills-architecture`)

Built. The measured gap first: **`SYSTEM.md` had sat on disk since SK-5 and no
code ever opened it**, and `extends: alma-base` was never resolved either. The
file meant to replace the general prompt was never read, which is why isolation
"existed" only as a manifest field.

A pinned skill declaring `isolation: subagent` now makes the STABLE prompt
`compileStableCore()` + alma-base + its `SYSTEM.md` + its `SKILL.md`. The ~25
business-domain modules are not assembled at all. Only the stable prompt is
swapped — per-turn state (memory, time, project instructions, dependency
preflight) is not behavioural prose and an isolated job needs it too.

| | inline (today) | isolated |
|---|---|---|
| stable prompt | 99,245 chars | **19,401** (−80%) |
| unrelated modules present | 22 | **0** |

Enforcement is measured, not asserted: `findPromptLeaks()` searches the prompt
that was actually built for the text of any non-kernel module. A companion test
asserts a NORMAL turn still shows 22, so the check cannot pass vacuously. The
`skill_pinned` SSE event carries `isolated`, so the claim is checkable from
outside the server.

**Deliberately not `runSubAgent`,** which the plan suggested. That runner caps at
4 tool iterations and 2048 output tokens, does not stream, and returns a summary
string — the SEO batch needs 5–7 rounds and the owner asked to watch the work.
Isolation is the two things that carry the guarantee — own system prompt, own
tool list — delivered inside the streaming turn.

Gate: `AGENT_SKILL_ISOLATION` (off in prod, auto-on preview) **and** a
conversation pin. Without a pin the selection can move mid-chat, and swapping
the system prompt per turn would rewrite the cached prefix every message.

## SK-6 — global hacks into skills (2026-07-27, same branch)

Two slices shipped. The rule applied throughout: **global code keeps what is
true of every job; a skill keeps what is true of one job.**

1. `buildOwnerRequirementNote` stopped emitting the client-SEO procedure, and
   `run-owner-turn` stopped hardcoding an injection of `run_website_seo_audit` /
   `check_website_seo_audit` / `save_artifact`. With a skill pinned that
   injection is worse than redundant — it hands back tools the skill withheld.
2. The big one: **6.2 KB (2,993 chars) of client-SEO procedure was living inside
   the `computer_capabilities` prompt module** and shipped on every turn holding
   a browser or workbench tool. It was extracted into its own module, skipped
   whenever a skill was pinned, and then — later the same day, once measured —
   **deleted outright**. The knowledge lives in `seo-fixing-client-site/SKILL.md`.
   See "SK-6 finished" below.

**Corrections to this file's own candidate list.** The "alt false-positive lore
in global code" does not exist: it is correct crawler logic in
`grind/page-measure.ts` and `seo/technical-audit.ts` (code, not prose) plus a
historical comment in `turn-loop-policy.ts` that changes no behaviour. And the
durable client-SEO batch machinery is a RUNNER, not task knowledge — it stays,
by the same line that keeps the skill-pack runner in code.

**A correction to what this file said earlier.** It claimed the engine was
"preview only, production untouched". Measured 2026-07-27: the KV row
`skill_engine_enabled = "true"` exists, and `isSkillEngineEnabled()` reads KV
BEFORE env — so the engine has been on in production too. The env var only
matters while no KV row exists, which stopped being true at some point nobody
recorded. `AGENT_SKILL_ISOLATION` has no KV path and is genuinely env-only.

### SK-7 live proof — done 2026-07-27, in his own Chrome

`"isolated":true` on the `skill_pinned` SSE frame, on the preview host, with the
chip visible and the job running to an approval card. The claim is checkable
from outside the server, which is the whole point of putting it on the wire.

The same session proved the rest of the loop end to end: a Banglish fix order
pins the fixing skill at the RULE layer, a pin follows the job when the job
changes, an answered card leads to WORK rather than another question, and an
approval makes the agent carry on by itself.

## Not done — start here

### SK-6 finished — 2026-07-27

`CLIENT_SEO_AUDIT_PROCEDURE` and its registry entry are **deleted**, not
skipped. `seo-fixing-client-site/SKILL.md` is now the only description of that
job anywhere. The always-on prompt went **95,883 → 92,890 chars**.

Measured before removing it, because the whole programme is about not
asserting: ten client-SEO phrasings, **ten pins, zero "SEO job with no skill
pinned"** — the case the text existed to cover did not occur.

Two things stayed on purpose:

- **The two one-line contract statements** in `buildOwnerRequirementNote`
  ("a crawl per target", "prose alone is not delivery"). ~150 characters, silent
  when a skill is pinned. They are the floor if the engine is ever switched off
  — it is a KV row, flippable in a second, and without them a client-SEO turn
  would then carry no procedure at all. Delete when the engine being off stops
  being a plausible Tuesday.
- **`SKILL_OWNED_MODULES`**, now empty. The mechanism is what makes the next
  migration cheap: move the text into a skill, list the module id, prove it in
  production, delete. Keeping it documents the pattern in code rather than in
  someone's memory.

### SK-8 shipped — 2026-07-27 (PR #620)

Provenance: content hash per skill (`manifest.json` + `SKILL.md` + `SYSTEM.md`),
an approval ledger in KV (who, which version, when, note), and revoke as the
runtime rollback — it takes a skill out of service on the next turn, no deploy.
A held-back skill says why in Bangla rather than behaving as if nothing matched.

`AGENT_SKILL_APPROVAL_GATE` is OFF and does NOT auto-enable on preview: turning
it on against an empty ledger would disable every skill at once. See item 1.

**The four enterprise pillars are now all present** — eval harness (SK-1), tool
allowlist (SK-4), selection trace (SK-3), provenance (SK-8).

1. **Populate the approval ledger, then turn the gate on.** Run with
   `AGENT_SKILL_APPROVAL_GATE` off, read the `[skill-provenance]` lines, approve
   what should run via `approveSkill()`, then switch the gate on and prove a
   revoked skill actually stops running.
2. **Eval-gate the isolated path** against the inline baseline with
   `compareToBaseline()`. The harness is a pure scorer, so it needs recorded
   runs; the runs now exist, nobody has scored them.
3. **Promote the 16 originals**, one at a time, each with evals — 79 lint
   findings are the work list (`docs/skill-lint-report.md`).
4. **`isolation: subagent` for the other two SEO skills** — each needs its own
   `SYSTEM.md` written, and promotion is one at a time, never a batch.
5. **Router's last misses** — all skill-description gaps, not router gaps.
6. **Registry budget and the selection trace** are written but never exercised at
   scale; revisit when more than ~10 skills are active.
7. **Drop Upstash from the turn queue** (optional). It exists only because
   Vercel and the VPS must share one queue; a Vercel→VPS HTTP handoff would let
   the VPS use its own local Redis and remove the metered dependency entirely.

## Flags

`SKILL_ENGINE_ENABLED=true` is set on **Vercel Preview only**. Production is
untouched — `isSkillEngineEnabled()` reads the KV row first and falls back to
env, so as long as no KV row exists, preview and production stay separate. I
told him earlier they could not be separated; that was wrong.
