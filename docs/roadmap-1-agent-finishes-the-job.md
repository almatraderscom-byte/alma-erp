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
| **PM-1** | conversation column, API, composer chip, per-turn echo, mode on every tool event. **Shadow: recorded and shown, nothing enforced** | **done** — chip + persistence live-proven in his Chrome (`permissionMode:"plan"` survived a reload) |
| **PM-2** | enforce Plan and Careful (tightening only) + the advisor wired into the guard's refusal | **done** — Plan withholds every effect tool; Careful stages an R1/R2 write as a real card; a mode refusal carries the minimum mode that would allow it |
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

1. **`run_website_seo_audit` is missing from the `seo-auditing-own-site` tool
   list.** Live 2026-07-27 on the DeepSeek head: the first rounds of an audit
   turn all failed with "run_website_seo_audit was NOT in my tool list". It
   recovered by fetching pages directly, but those rounds were wasted.
2. **Skill routing sends a FIX request to the AUDIT skill.** "…ঠিক করে দাও"
   pinned `seo-auditing-own-site` more than once. Roadmap-2 territory, recorded
   here because it costs rounds today.
3. **The 2 tagless pages** (`7-b`, `mm03`) need a storefront fix, not agent copy.
4. **Nothing is merged to main.** Everything is on the branch, live-verified
   piece by piece.

## Fixed later on 2026-07-27 (second pass, each live-checked)

7. **A corrected retry is not hammering.** The failure guard refused to push when
   the head named the same tool that just failed — right for a broken call, wrong
   when the head itself said the ARGUMENTS were wrong. It now reads the failure's
   error class. An honest admission that comes with work in flight is no longer
   read as a sign-off either.
8. **A job keeps its size.** The work class is remembered for the conversation
   (45-minute expiry, widening only), so a two-word answer to the agent's own
   card no longer shrinks a 60-round job back to an 8-round chat reply.
9. **After he answers, it works instead of asking again.** On an answer turn the
   prose-choice rule no longer promotes a stray question into a second card.
10. **The card may only report a decision he actually made.** `owner_decided` is
    written solely by the approve/reject routes; `resolvedAt` was the wrong
    signal (the worker's job-result callback stamps it too). **Live-proven** —
    the audit card now reads "অনুমোদন লাগেনি — নিজে থেকেই হয়ে গেছে".
11. **"approved" no longer reaches him meaning "still crawling"** — the audit
    tool returns a `stateBn` the head can say out loud.
12. **Leaked tool-call text is stripped** before it reaches the chat, with the
    tool names logged so a claim resting on a fake call stays catchable.
13. **The loop.** Raising the push limit without changing the sentence produced
    one: three server notes arrived as plain `user` messages, the head read them
    as Boss repeating himself, and answered each by saving memory — 45 steps,
    $0.90. Fixed on three legs: every server note now carries an INTERNAL CONTROL
    marker (including the periodic constitution reminder), a push must be EARNED
    by a non-bookkeeping tool success, and the push ESCALATES instead of
    repeating. **Live-proven on DeepSeek V4 Flash: 21 steps, $0.03, no loop, and
    an honest negative finding** ("দুর্বল title বা thin description আসলে নেই").

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
