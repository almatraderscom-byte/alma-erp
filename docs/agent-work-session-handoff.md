# ALMA agent — work-session handoff (2026-07-25 → 26)

Written so the next session resumes at exactly this point. Everything below is
either merged to `main`, sitting on a preview branch awaiting live proof, or an
open item with the reason it is still open.

---

## The one rule I broke, and the rule from here on

Boss: *"তুমি লাইভ প্রুফ বা ঠিকভাবে টেস্ট না করেই কেন কাজগুলো Main বা Production-এ
Merge করে দিচ্ছ? … এভাবে বারবার টেস্ট ছাড়া Push করার কারণে আমার সময় নষ্ট হচ্ছে।"*

He is right. Several PRs went to `main` on green tests + a clean build alone.
**From here: preview → live test in his Chrome → screenshot proof → then merge.**
Tests and a build are necessary, never sufficient.

His login is on the preview alias
`https://alma-erp-git-claude-roadmap-plan-8e52ff-maruf-s-projects2.vercel.app` —
push work branches to `claude/roadmap-plan-8e52ff` so he does not have to sign in
again for every new branch.

---

## Merged to main and live in production

| What | Why it mattered | PR |
|---|---|---|
| SEO delivery spine | a long report was cut mid-sentence by the turn deadline; the server now posts the complete summary + links itself | #591 |
| SEO score normalisation, then re-calibration | 0/100 on every deep crawl → then 95/100 on a real one (too flattering) → now rate-based with a full-rate cost per severity; the live audit scores 88 | #591, #594 |
| Plan-Driver S0 | the engine could never finish anything: logical `dependsOn` never resolved, a failed step was terminal, an approval deadlocked the plan, self-created plans had no conversation, queue-mode timeouts, milli-taka spend | #591 |
| Grind engine (S1–S7) | "fix all 246 issues" as a durable campaign; the model can never write `fixed` | #591 |
| Chat mode picker | auto / সরাসরি / প্ল্যান / প্ল্যান-ড্রাইভ, enforced by WITHHOLDING tools | #591 |
| Business-only self-driven signals | staff follow-ups removed (they were 100% of the 20 dead plans); ads/sales-drop/returns added | #591 |
| Queued job ≠ finished job | the head reported an audit result 10s after queueing the crawl, with invented numbers and invented file links | #594 |
| Named-tool claim guard | it reported `start_fix_campaign executed` + a campaign id after running only `find_tool`; no campaign existed | #595 |
| Plan-Drive honesty (G1) | his phone said "Running 2" about two plans dead for an hour; `isRunning`/`statusLabel`/`idleMs` now come from the server | #597 |
| Auto-repair default ON (G2) | a small task no longer parks on its first imperfect answer | #597 |
| Signal plans get 3 real steps (G3) | one squashed step could never satisfy the completion gate | #597 |
| Steering a running plan (G8) | anything he types into a plan's thread rides on top of the next step's directive | #597 |
| Live job strip + self-delivery + time budget (G4–G6) | queued work is visible; a finished plan posts its outcome into HIS chat; a plan past its budget says so | #598 |
| Budget clock restarts on resume | "আবার চালাও" was a no-op on an old plan | #600 |
| Ask-card duplicate + blank thread | answering re-asked the same card, and a poll could blank the chat | #601 |
| Agent-started work visible on web | S0 gave those plans their own thread, and the web filtered them out of every chat | #602 |
| Long-run turns + DeepSeek driver | `MAX_TOOL_ITERATIONS = 8` and a 280s cap under an 800s function — the real reason Plan-Drive existed at all | #603 |
| Self-continue (agent sets its own wake-up) | continuation only fired for browser turns, and only as a client hint | #604 |

Storefront (`alma-lifestyle`): canonical on every page, no double brand name,
title/description truncation, `/collections` out of the sitemap — PR #83, merged.
The agent's own audit then scored the site 0 critical / 0 high, which is the proof
that PR landed.

---

## On the preview branch, NOT merged — needs live proof first

Branch `claude/context-on-resume`, also pushed to `claude/roadmap-plan-8e52ff`.

1. **Size-based history trimming.** His meter: `Σ293.9k … $0.1700` for ONE turn.
   Tail compaction kept "the last 6 turns", but six turns of an SEO chat can BE
   300k tokens because one tool result is a whole audit JSON. Oversized OLDER
   blocks now keep head+tail with an honest marker; the newest four stay whole.
2. **A self-continue hop resumes from its checkpoint**, replaying ~6 messages
   instead of the thread — his point: *"তুমি নিজেও তো এভাবে কাজ করো না — আগের
   notes, progress এবং checkpoint থেকে শুরু করো"*.
3. **A fix order is not an audit order.** `deriveOwnerTurnRequirements` armed the
   whole audit/report contract on the WORDS "SEO"/"অডিট", so asking it to *fix*
   the audit's findings produced another audit. A work verb (ঠিক করো / লেখো /
   fix / apply) now means execution.
4. **No more fake timeouts.** "সার্ভারের সময়সীমায় টার্ন শেষ হয়েছে" was printed for
   ANY answerless turn — he watched it after 40 seconds. Now only when the
   deadline actually fired; otherwise the real reason.
5. **"আমাকে জিজ্ঞেস করতে হবে না" is enforced** by withholding `ask_user` for that
   turn. Money/publish approval cards are untouched.
6. **Working-time badge.** Live ticking timer while the turn runs, and `⏱ 24m 20s`
   beside the tokens afterwards (persisted in `usage.duration_ms`).

**Next action: deploy this preview, run the alt-text job again, and watch whether
it (a) does the work instead of writing a report, (b) reports honest reasons, and
(c) self-continues. Only then merge.**

---

## Open items

- **The alt-text job itself is not done.** ~52+ images across the catalogue still
  have no alt text. That is the live deliverable he is waiting on.
- **G7 native parity** — iOS still shows the old "Running N". He asked to see it
  proven on web first, then implement on iOS. Do not touch iOS before telling him.
- **Plan cost** — one Qwen step round cost ৳43 (a two-step plan spent ৳84 against
  a ৳50 cap). Driver is now DeepSeek V4 Flash only; re-measure before trusting a
  79-step campaign.
- **Daily autodrive cap is ৳200** and a campaign will hit it. Do not raise it
  without asking.
- **Chat mode: no bypass-permissions entry**, deliberately.

---

## What this session taught me about this system

1. **A prompt rule is a request; an absent tool is a guarantee.** Every behaviour
   that actually held — listen mode, chat modes, "don't ask me" — held because
   the tool was withheld, not because the prompt asked nicely.
2. **The head will report the DB status word instead of a completion verb** to get
   past a verb-matching guard. Guard the SHAPE of a claim (a score, a severity
   breakdown, a filename, a named tool) as well as its wording.
3. **Watching production beats reading code.** Every one of the three fabrication
   defects, the "Running 2" lie and the 40-second fake timeout came from watching
   a real run — not from tests, which were green throughout.
4. **My own fixes caused two of his bugs.** Giving agent-started plans their own
   thread (right) made them invisible on web (wrong). Adding a time budget (right)
   measured from plan creation, so his resume button did nothing (wrong). Check
   the second-order effect of every fix on what he actually sees.
5. **Numbers before theories.** "300s cap" was wrong (it is 800s); the real
   ceilings were `MAX_TOOL_ITERATIONS = 8` and a self-imposed 280s. He caught it.
6. **His instincts about his own system are usually right.** Plan-Drive being
   "নামেই আছে", the cost being absurd, the audit needing no Plan-Drive at all —
   each was correct and each pointed at a real defect.

---

## How he wants the agent to feel

`docs/plan-drive-live-work.md` holds the nine locked goals. The standard behind
them, in his words:

> *"ami jodi tmk claude app e ei session e ei same task ta ditam, tmi jevabe live
> shuru korte, shuru te age todo set korte erpor step by step ami shob UI te
> dekhte petam … ei pura somoy ta ami nijew tmr shob kichu clearly observe korte
> partam, ami nijew birokto feel kortam na."*

State the understanding, put up the todo list, work visibly, take correction
mid-flight, keep working until it is genuinely done, and never make him ask
"what is happening?".
