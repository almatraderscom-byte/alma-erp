# Session prompt — Roadmap 3 (ads first, then computer, then Chrome)

Copy everything below the line into a fresh session. It is written so the agent
can start working without asking you anything first.

---

Read these before touching anything:

- `docs/roadmap-3-skills-for-every-job.md` — the plan, with the market research
  and the sources behind the ORDER. Read the research section properly; it is
  the reason the order is what it is.
- `docs/roadmap-2-skill-architecture.md` — how the skill system works, and the
  two rules that everything held on.
- `docs/HANDOFF.md` §2b — nine defects I caught in a session that had already
  been called "verified". Read it as a warning about your own testing.

Then open a branch off `main` called `claude/ads-expert`. Do not merge to main
without asking me.

## The one thing not to get wrong

The three surfaces I want are **not equally ready**, and the research is blunt
about it:

| | reality in 2026 |
|---|---|
| Ads via Marketing API | deterministic, auditable — ready now |
| Computer use, long-horizon | best frontier system **20.6%** on OSWorld 2.0 |
| Browser on my Mac's Chrome | **~22% in production** against a 78% benchmark |

So: **ads first, computer second, Chrome last and narrowest.** Do not start all
three. Do not let my enthusiasm change that order — if you think it should
change, show me numbers.

## Start here: ADS-0, and only ADS-0

**ADS-0 — the agent audits my ad account itself. Read-only.**

Account structure, active campaigns, spend against cap, creative fatigue,
attribution drift. No writes, no card, no suggestions to change anything yet.

The deliverable is two things:
1. the audit itself
2. **the no-skill baseline recorded** — because every later claim that "the
   skill helped" is measured against this, and if it is not captured now it
   cannot be reconstructed

Then stop and show me. Do not continue to ADS-1 in the same session unless I
say so.

## What comes after (so you know where this is going)

- **ADS-1** — you verify that audit independently against the Graph API and my
  own numbers. **Every disagreement gets written down.** In the SEO programme
  this step was the whole value: it turned "52+ images missing alt" into "zero
  real defects", and that finding in `traps.md` later saved a morning.
- **ADS-2** — `ads-auditing` skill, read-only, holds no write tool. 3 evals, no
  regression against the ADS-0 baseline.
- **ADS-3** — `ads-running`, the professional buyer. Agent owns the
  high-frequency loop (creative variants, A/B, budget shifts inside a CBO,
  pausing fatigued ads); I own account structure, the offer, and spend caps.
  `implicit: false` so it never auto-triggers.
- **ADS-4** — you run the whole flow live and I watch.

## Non-negotiable for anything touching ads

- **Money gates live in CODE, never in skill text.** A skill may say "never
  exceed ৳500/day"; only the server can guarantee it.
- **New campaigns land PAUSED.** Meta's own connectors do this deliberately.
- **Escalate, do not act**, when attribution drifts ~15% from the modelled
  number or one ad's daily spend crosses the cap.
- **Read-only earns write.** ADS-3 does not get write access until a week of
  proposals I actually agreed with. Do not compress that week — mistakes here
  cost money, not just time.

## How I expect you to work

- **Live proof before you say anything is done.** Tests passing is not proof.
  Screenshot from my Chrome. If it needs my login, ask and wait — never type my
  password.
- **Test the way I type**: one plain sentence, Banglish or Bangla, no tool
  names. If it only works when you spell out the steps, it failed.
- **Watch the whole screen, not just your feature.**
- **A prompt rule is a request; an absent tool is a guarantee.**
- Diagnose before changing anything, and tell me the diagnosis first.
- Reply to me in Bangla. Code, commits and docs in English.
- My target is enterprise, so treat versioning, approval and rollback (SK-8,
  already built) as part of every skill you ship — not an afterthought.
