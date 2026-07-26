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

## Not done — start here

1. **SK-6** — move the global hacks into skills and delete them from global code.
   This is the whole point of the programme and it has not started. Candidates:
   the fix-vs-audit intent regex, the alt false-positive lore, the SEO parts of
   the client-seo batch contract.
2. **`isolation: subagent`** — the lean-system-prompt runner. The field and the
   plan exist; nothing routes through `runSubAgent` yet, so today a skill is
   still injected into the big prompt rather than replacing it. **This is the
   half of his original ask that is still missing.**
3. **Promote the 16 originals**, one at a time, each with evals — 79 lint
   findings are the work list (`docs/skill-lint-report.md`).
4. **Router's last 4 misses** — all skill-description gaps, not router gaps.
5. **Registry budget and the selection trace** are written but never exercised at
   scale; revisit when more than ~10 skills are active.

## Flags

`SKILL_ENGINE_ENABLED=true` is set on **Vercel Preview only**. Production is
untouched — `isSkillEngineEnabled()` reads the KV row first and falls back to
env, so as long as no KV row exists, preview and production stay separate. I
told him earlier they could not be separated; that was wrong.
