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
   a browser or workbench tool. Now `client_seo_audit_procedure`, its own module,
   skipped whenever any skill is pinned (`SKILL_OWNED_MODULES`) — and the skip
   outranks `forceFullPrompt`, so "ship everything for cache stability" cannot
   resurrect it. The knowledge moved into `seo-fixing-client-site/SKILL.md`.

**Corrections to this file's own candidate list.** The "alt false-positive lore
in global code" does not exist: it is correct crawler logic in
`grind/page-measure.ts` and `seo/technical-audit.ts` (code, not prose) plus a
historical comment in `turn-loop-policy.ts` that changes no behaviour. And the
durable client-SEO batch machinery is a RUNNER, not task knowledge — it stays,
by the same line that keeps the skill-pack runner in code.

**What SK-6 cannot finish yet.** "Delete from global code" is staged: the global
copies still serve the no-skill path, which is production today with the engine
off. Behaviour there is unchanged, and a test asserts that rather than assuming
it. When the owner turns the engine on in production, deleting
`CLIENT_SEO_AUDIT_PROCEDURE` and its registry entry is the whole removal.

## Not done — start here

1. **Live proof of SK-7 on preview** — the one thing still outstanding for it.
   Needs the owner to log in to the preview host (separate cookie origin).
2. **Eval-gate the isolated path** against the inline baseline with
   `compareToBaseline()`. The harness is a pure scorer, so it needs real runs —
   also blocked on the live preview.
3. **Promote the 16 originals**, one at a time, each with evals — 79 lint
   findings are the work list (`docs/skill-lint-report.md`).
4. **`isolation: subagent` for the other two SEO skills** — each needs its own
   `SYSTEM.md` written, and promotion is one at a time, never a batch.
4. **Router's last 4 misses** — all skill-description gaps, not router gaps.
5. **Registry budget and the selection trace** are written but never exercised at
   scale; revisit when more than ~10 skills are active.

## Flags

`SKILL_ENGINE_ENABLED=true` is set on **Vercel Preview only**. Production is
untouched — `isSkillEngineEnabled()` reads the KV row first and falls back to
env, so as long as no KV row exists, preview and production stay separate. I
told him earlier they could not be separated; that was wrong.
