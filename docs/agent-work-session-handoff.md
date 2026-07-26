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

7. **Capability preflight.** The live run below showed the head spending 15
   steps and 1m36s discovering, one tool at a time, that the website DB was
   unreachable. A block now names the dead capability and the exact missing env
   var before step 0 — and is empty (zero bytes) when nothing is down.

---

## The live proof run — 2026-07-26, preview, his Chrome

I gave the agent the alt-text fix order myself on the preview alias, in **auto**
mode (not Plan-Drive — his point was that this job never needed it).

Everything in the batch held:

| | before | on this build |
|---|---|---|
| fix order | produced another SEO report | went straight to the work |
| turn end | "সার্ভারের সময়সীমায় টার্ন শেষ" after 40s | "কাজ শেষ হয়নি — ৩০ সেকেন্ড পরে নিজেই চালিয়ে যাব, hop 1" |
| clock | none | `⏱ 1m 36s` beside the tokens |
| self-repair | — | "নিজে যাচাই করে ঠিক করেছে" chip |
| cost | ~$0.17/turn | $0.0335 (722.9k of 837.6k served from cache) |

**But the alt-text job still did not happen, and the reason was never the code.**
The agent said so honestly: `audit_product_seo` / `draft_seo_fixes` /
`update_product_web` all need the website Supabase connection, which was not
configured. Vercel confirmed it exactly:

```
WEBSITE_SUPABASE_SERVICE_ROLE_KEY   Production, Preview
WEBSITE_SUPABASE_URL                Production          ← missing on Preview
```

Half configured for 42 days: the key on both, the URL on one. Same trap as the
storage key before it. With his approval I added the URL to Preview
(`https://awugvcjezittjjgfysuk.supabase.co` — the storefront's own public
project URL, so no secret was handled). Production was not touched.

## Blocked: every new deploy, by another agent's migration

The redeploy then failed, and so will any deploy until it is cleared:

```
P3009 — migrate found failed migrations in the target database
20260921130000_creative_lifecycle_production  failed 2026-07-26 06:48:58 UTC
```

- It belongs to branch `codex-cs-v3-lifecycle` (Codex agent, commits `477bd64d`,
  `fae40b8c`).
- **`DATABASE_URL` on Vercel is ONE record covering Production *and* Preview** —
  so preview deploys run migrations against the live database. That is the
  structural hazard worth fixing separately.
- The data is fine: the migration is wrapped `BEGIN; … COMMIT;` and rolled back.
  Only the `_prisma_migrations` row is marked failed, and Prisma then refuses
  every later migration. Production itself keeps serving normally — only new
  deploys are blocked.
- **Owner ruling: leave it to Codex.** Do not run `migrate resolve` on his live
  database.

**Next action: once deploys unblock, re-run the alt-text job on preview — the
env is now in place — and take the proof. Only then merge.**

---

## The alt-text job was mostly not a job

Before writing a single alt I fetched the live pages myself. The audit's headline
— "52+ images without alt across the catalogue, hurting Google Images and
accessibility" — was almost entirely false positives:

```html
<div class="foot-strip" aria-hidden="true"><img src="…" alt=""/>     <!-- decorative -->
<button aria-label="সি-গ্রীন কালার পাঞ্জাবী …"><img alt=""/></button> <!-- name already there -->
```

A decorative image is SUPPOSED to carry `alt=""`, and an image inside a control
that already has an accessible name would be announced twice if it had one.
Measured live, old rule vs corrected:

| page | before | real |
|---|---|---|
| `/products/product-code-110-men` | 12 / 30 | **0 / 18** |
| `/products` | 12 / 28 | **0 / 16** |
| `/products?category=islamic` | 12 / 26 | **0 / 14** |
| `/` | 34 / 52 | **16 / 40** |

What survives is 16 genuinely unlabelled images in the homepage `.scard` blocks
— a real but small job, and one that lives in the **storefront repo**, not in
`product_images.alt_text`. Fixing it the way it was being asked for could never
have worked. (The Desktop `alma-lifestyle` checkout is stale — 2026-06-07 — so
`.scard` is not in it; pull before touching that repo.)

Finder (`worker/src/seo/audit.mjs`) and verifier (`grind/page-measure.ts`) now
share the rule, with tests built from the real markup.

## Two more turn defects the same run exposed

1. **A fix order armed the audit contract again.** `FIX_INTENT_RE` listed exact
   word forms, so the next thing Boss typed — "alt লিখে সেভ করো" — slipped past
   it. It matches verb STEMS now, and an explicit ask for the audit/report still
   wins over the verb.
2. **A contract demanded a tool the round had taken away.** The head spent its
   tool budget, the budget strip emptied the list, it then called the contract's
   `run_website_seo_audit` and the membership gate refused it — "বাধ্যতামূলক ধাপ
   সফল হয়নি" over a tool the server itself withheld. A contract-required tool now
   survives the strip.

## How to test the agent (owner correction, 2026-07-26)

Boss watched me test and caught me coaching: my message told the agent which
steps to take ("আগে গুনে বলো, তারপর ব্যাচে কাজ করো"). *"tmk as owner reply moto
test kore success niye ashte hobe, ami just normal kaj ta bolbe erpor agent nije
shob kichu korbe"*. Test with ONE plain sentence, the way he would type it. No
tool names, no step list. If the agent needs the steps spelled out, it failed.

## Open items

- **The alt-text job itself is not done.** ~52+ images across the catalogue still
  have no alt text. That is the live deliverable he is waiting on. The env gap is
  now closed on Preview; the blocker is the failed migration above.
- **Preview deploys migrate the production database.** One `DATABASE_URL` record
  serves both environments. Today that let another branch's broken migration
  block every deploy in the project. Worth raising with him as its own decision;
  nothing here should change it unasked.
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
