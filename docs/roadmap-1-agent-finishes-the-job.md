# Roadmap 1 — the agent finishes the job by itself

**Own session. Own branch (`claude/roadmap-plan-8e52ff` today).**
Sister roadmap: `docs/roadmap-2-skill-architecture.md` — run it in a SEPARATE
session, on its OWN branch. Owner's instruction, 2026-07-26.

The goal in his words: give the agent a job, and it plans, works, reports and
finishes — without dribbling twenty-second fragments and approval cards at him.

---

## Where the SEO work actually stands (measured live, not reported)

Every number below comes from fetching the live pages myself. The agent's own
count is never the evidence — that lesson cost most of a day.

| | |
|---|---|
| product pages in sitemap | **89** |
| meta description ≥ 50 chars | **87** ✅ |
| title 10–70 chars | **87** ✅ |
| **remaining** | **2 pages** |

The two stragglers are `ইসলামিক ৭টি বইয়ের কম্বো প্যাকেজ (7-b)` and `mm03`. Both
render **no title and no meta tag at all** (0 chars), so this is not "copy not
written yet" — those pages are missing the tags, which is a storefront template
question, not an ERP copy question. Do not hand it to the SEO fix skill.

The agent's own audit of the 50 catalogue products agrees and adds detail:
`lowSlug: 2 · missingMeta: 0 · weakTitle: 8 · weakAlt: 0 · thinDescription: 4`.

**So: the meta/description job the owner originally asked for is DONE.** What is
left is small and different in kind — 2 slugs, 8 weak titles, 4 thin
descriptions, and the 2 tagless pages.

### The finding that reframed the whole job

The audit's headline — "52+ images without alt" — was almost entirely FALSE. A
decorative image is *supposed* to carry `alt=""`, and so is an image inside an
`aria-label`led control. Measured live: product and category pages have **0**
real missing alt; only the homepage `.scard` blocks have 16, and those live in
the **storefront repo**. Both the crawler and the verifier were corrected.

The real problem was meta descriptions, and that is what got fixed.

---

## What shipped this session (all on the branch, none merged)

| | |
|---|---|
| A drafted SEO batch no longer expires in 30 minutes | the loop that made him approve four different cards |
| Approval loader starts on the CLICK, not after the write | the "agent is asleep" complaint |
| After an approval the head gets the FACTS (how many applied, what is still pending) | it kept saying "waiting for approval" for finished work |
| Process section opens the moment work starts | at 10s the screen was blank; measured |
| Live thinking during a worker-run continuation | that path only polled messages; the placeholder was a false promise |
| Which skill is running, as a system line + in the agent's own first line | he showed me ChatGPT doing it |
| New chats default to Auto, not Sonnet | every new chat silently pinned the priciest head |
| Context meter survives a model switch; compaction follows the WINDOW, not dollars | his two explicit asks |
| A switched head is told it is continuing, not starting | so it stops re-introducing itself |
| Progress update every 3 silent tool rounds | "koyek ta dhap sesh kore amk age update daw" |
| Plan-first on a big job — read, plan, ask everything once, then execute | "ami tar ei kajer plan e dekhte pai ni" |

---

## Permission & autonomy modes — APPROVED 2026-07-27, in progress

Design of record: `docs/PERMISSION-MODES-PLAN.md` (v2). Five layers that can only
tighten downward, five modes with Plan restored as a real permission mode, and R4
owner-only in every one of them by the tier ceiling rather than by a prompt.

His added requirement, same day: **the agent must SEE the mode and say so.** If
he takes a plan and then asks for the work without switching, it must name the
mode it is in, why it cannot, and which mode would do it — and never switch the
mode itself. Covered in §3.6 and shipped as part of PM-0's advisor.

| Phase | Ships | Status |
|---|---|---|
| **PM-0** | `permission-mode.ts` — the table, the advisor, the per-turn banner. Pure, no wiring | **done** — 22 tests |
| **PM-1** | conversation column, API, composer chip, per-turn echo, mode on every tool event. **Shadow: recorded and shown, nothing enforced** | next |
| **PM-2** | enforce Plan and Careful (tightening only) + the advisor wired into the guard's refusal | |
| **PM-3** | allow/ask/deny rules with resource patterns + the organisation-policy tier | |
| **PM-4** | grants on the card: once / this job / 30 min / always, server-side expiry, revoke screen | |
| **PM-5** | context inheritance — `turnId` + origin + mode into sub-agents; declared modes for cron/heartbeat/plan-driver | **pull early: this is an open hole today**, not just design |
| **PM-6** | Supervised mode: on-the-loop + undo + approval batching | |
| **PM-7** | Elevated mode: time-boxed grants, auto-revocation, elevated logging | |
| **PM-8** | governance surface: override rate, response time, timeout policy, dual control, "why did this need approval" | |

## Fixed 2026-07-27 (branch only, each live-checked in his Chrome)

1. **`draft_seo_fixes` duplicate-guard false positive.** Root cause was not what
   this document said: the guard never fired on a genuinely different batch — a
   different payload hashes to a different key. It claimed the idempotency key on
   guard-ALLOW, before the handler ran, so a *failed* staging call locked the same
   batch out for ten minutes. The claim is now released on every failure path.
2. **"card বানাচ্ছি" was invisible to the verifier** — the whole বানা- family was
   missing from the card-promise detector, while its synonym তৈরি করছি was covered.
3. **A staged pending action now counts as a real card**, so a truthful claim
   after a successful staging call is not punished as an unbacked promise.
4. **The opening line is a claim too.** Speak-first streams before any tool runs
   and survives every rewrite, so a promise made there was unfalsifiable. When it
   promises a card and none exists, the reply must correct it. **Live-proven the
   same day** — the agent wrote *"(কার্ড তৈরি করতে পারিনি, সেটা সংশোধন করলাম।)"*.
5. **Card state is read, not asserted.** Every turn carries the server's count of
   pending cards, and "waiting for approval" with zero cards fails verification.
6. **A work turn gets a work-sized budget.** A deep turn was allowed 60 rounds
   while the standard head's tool budget stripped its tools after 8 — and on
   preview, where he tests, that budget is live by default. The budget now
   follows the turn class.

## Still broken — start here

1. **An announced next step after an ARGUMENT failure is suppressed.** Live
   2026-07-27: the head said "এখন সঠিকভাবে চালাচ্ছি" and the turn ended.
   `turn-loop-policy.ts:114` refuses to push when the head names the same tool
   that just failed — right for hammering a broken call, wrong when the head
   itself said the *arguments* were wrong. Needs the failure's error class, not
   its name.
2. **The turn's work class resets on every follow-up turn.** "পুরো …" earns 60
   rounds; tapping "হ্যাঁ, এখনই শুরু করুন" earns 8, because the class is derived
   from the latest message alone. A job must keep its class for its lifetime.
3. **It asks again after he has already answered once.** The prose-choice rule
   turned narration containing "(recommended)?" into a second ask card.
4. **The approval card lies about who approved.** `AgentConfirmCard.tsx:36` shows
   "আপনি অনুমোদন করেছিলেন" for any row that reaches `executed`, including the SEO
   audit rows that are created already-approved and never went to him.
5. **"approved" means "still crawling"** in the audit tool, and the head repeats
   the raw word to him — it reads as "waiting for your approval".
6. **The 2 tagless pages** (`7-b`, `mm03`) need a storefront fix, not agent copy.
7. **Nothing is merged to main.** Everything is on the branch, live-verified
   piece by piece.

---

## How he wants this tested (his correction, and it stands)

- **Never claim from code.** Every claim needs a live screenshot from his Chrome.
  I broke this repeatedly and he caught it every time.
- **Test the way HE types** — one plain sentence, no coaching the agent with tool
  names or step lists.
- **Test the FLOW, not only the result:** did thinking appear immediately, could
  he open it, did an update arrive between phases, did it finish without asking
  him five times.
- **One path tested is not two paths tested.** A typed message and a
  post-approval continuation are different code paths; I verified one and claimed
  both, and he caught that too.
- **Set a real watcher before saying "after the deploy I'll…".** `vercel inspect
  --logs` returns EMPTY in a background shell — that is why three watchers
  silently never fired. Compare the alias's deployment URL instead, and check the
  watcher is actually reading values before trusting it.

---

## Standing authorisation

He authorised me to approve the SEO cards on his behalf until this job is
finished. That authorisation is for SEO copy on his own site, through the normal
approval cards — nothing wider.
