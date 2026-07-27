# Session prompt — Roadmap 2 (finish the skill system)

Copy everything below the line into a fresh session. It is written so the agent
can start working without asking you anything first.

---

Read these three files before touching anything:

- `docs/roadmap-2-skill-architecture.md` — status of record: what is done, what
  is not, and why
- `docs/skill-first-architecture-plan.md` — the design, with the research numbers
- `docs/HANDOFF.md` §2b — nine defects the owner caught in a session that had
  already been called "verified". Read it as a warning about your own testing,
  not as history.

Then open a branch off `main` called `claude/roadmap-2-finish`. Do not merge to
main without asking me.

## What is already true — do not rebuild it

SK-0 … SK-8 are done and merged. In particular:

- **`isolation: subagent` works and is live-proven.** A pinned skill runs on
  `compileStableCore()` + alma-base + its own `SYSTEM.md` + `SKILL.md`. Stable
  prompt 99,245 → 19,401 chars; unrelated prompt modules 22 → 0. The
  `skill_pinned` SSE frame carries `isolated`, which is how it was proven in the
  owner's Chrome — use the same method, do not re-derive it from code.
- **SK-6 is finished.** The client-SEO procedure is deleted from global code.
- **SK-8 provenance exists**: content hash, approval ledger, revoke.
  `AGENT_SKILL_APPROVAL_GATE` is off.
- Router is at **81%** on the owner corpus, false triggers 0. The rule layer
  understands Bangla script AND Banglish — he types both.

## Your work, in this order

**1. Populate the approval ledger, then turn the gate on.**
`AGENT_SKILL_APPROVAL_GATE=on` with an empty ledger disables every skill at
once. So: run with it off, read the `[skill-provenance]` lines, approve the
skills that should run (`approveSkill` in `skill-engine/approval-store.ts`),
then switch the gate on and prove a revoked skill actually stops running.

**2. Eval-gate the isolated path.** `evals/scoring.ts` is a pure scorer and
`compareToBaseline()` already blocks a skill if ANY scenario regressed, even
when the average improved. Runs now exist. Score isolated vs inline and write
the result into the roadmap. If isolation regressed anything, say so — that is
a finding, not a failure.

**3. Promote the 16 original skills, ONE at a time, each with evals.**
`docs/skill-lint-report.md` has 79 findings; the biggest single cause of the old
61% routing score is that 16 of 16 descriptions said WHAT but not WHEN. Never
promote a batch.

**4. `isolation: subagent` for `seo-auditing-own-site` and
`seo-fixing-client-site`.** Each needs its own `SYSTEM.md` written first. One at
a time, each proven live before the next.

**5. Optional: drop Upstash from the turn queue.** It exists only because Vercel
(producer) and the VPS (consumer) must share one queue; every other queue is
already on the VPS's local Redis. A Vercel→VPS HTTP handoff removes the metered
dependency. Its request quota is currently exhausted, so the app's inline
fallback is what runs — that fallback is no longer silent when it fails, but it
is capped at 90 s.

## How I expect you to work

- **Live proof before you say anything is done.** Tests passing is not proof.
  Open the preview in my Chrome, do the thing, screenshot it. If it needs my
  login, ask me and wait — never type my password.
- **Test the way I type**: one plain sentence, Banglish or Bangla, no tool names,
  no step lists. If it only works when you spell out the steps, it failed.
- **Watch the whole screen, not just your feature.** Every one of the nine
  defects in HANDOFF §2b came out of a session that had already been called
  verified. Duplicate lines, raw markup, a card that vanished — all of it was
  visible, nobody was looking.
- **A prompt rule is a request; an absent tool is a guarantee.** If you catch
  yourself writing a rule into a prompt to make behaviour hold, take the tool
  away instead. `find_tool` was quietly defeating the skill allowlist until
  2026-07-27 for exactly this reason.
- Diagnose before changing anything, and tell me the diagnosis first.
- Reply to me in Bangla. Code, commits and docs in English.
- The call-audio tuning in CLAUDE.md is frozen. Do not touch it.
