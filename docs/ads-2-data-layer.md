# ADS-2 (phases A–C) — giving the agent the whole Ads Manager

**2026-07-27, branch `claude/ads-expert`.** Read-only throughout: no write tool,
no approval card, no campaign touched.

Owner's ask, in his words: *"ads manager er aro onek kichu amr agent dekhte pay
na… ami cai ads manager er shob kichu jeno agent pay, ta hole she expert hobe
kivabe"*. He is right, and the reason turned out to be four separate defects —
three of them data we were already receiving and discarding.

---

## The four causes

| # | what he saw | what it actually was |
|---|---|---|
| 1 | Meta's own tools never work | **Every bridged Meta MCP call failed**: `-32602: Missing required argument: ad_account_id`, four in one production turn. The server has always known the account id; nothing put it on the wire, and the head cannot invent a numeric id it was never told. 23 registered read tools, advertised and unusable. |
| 2 | "৪টা চলছে" when Ads Manager shows 2 | We counted campaign-level `effective_status === ACTIVE`, which **stays ACTIVE while every ad set and ad beneath it is paused**. One of the four had spent $0.00 with 0 impressions for seven days. |
| 3 | "কত মেসেজ পাচ্ছি?" unanswerable | Meta sends an `actions` array with messages, link clicks, landing page views, leads, engagement, video views and purchases on **every** call. The code read `purchase` and dropped the rest. |
| 4 | fatigue and "limit-এ আছি?" unanswerable | `frequency`, `reach` and the account's `spend_cap` were **never requested**. `grep spend_cap` over the whole repo: zero hits. |

And the consequence of #3 that mattered most: his campaign is `OUTCOME_ENGAGEMENT`,
so it was judged on purchases, and the agent told him **"ROAS 0.0 — money waste"**.
ROAS on an engagement campaign is 0.0 by construction. That is a category error,
and acting on it would have paused a working campaign.

---

## What changed

**Phase A — the account id, and what "running" means.**
The bridge fills in the bare numeric account id (Meta rejects the `act_` prefix)
for any tool whose live schema declares it. It never overwrites one the head
supplied, and never pins `ads_get_ad_accounts` — that is how you discover
accounts. `delivering` now requires a live ad set **and** a live ad; the tool
reports `deliveringCount` / `deliveringNames` / `stalledNames` separately from
campaign-level status, and fails safe: with no structure data it answers as
before rather than claiming everything is stopped.

**Phase B — every result, judged by the campaign's own objective.**
`resultsFromActions()` parses the whole array, matching on stable fragments so a
Graph version bump cannot silently zero the messaging count
(`…messaging_conversation_started_7d` vs `_29d`), keeping unrecognised types in
`raw`. `primaryResultFor()` picks the metric the objective implies and reports
cost per result. Its unknown-objective fallback walks a value ladder rather than
picking the biggest number — 210 post engagements must never bury the 14 people
who actually started a conversation.

**Phase C — fatigue and the cap.**
`frequency` + `reach` on every campaign read, so fatigue is measured instead of
substituted with Meta's relevance label. `fetchAccountLimits()` reads
`spend_cap` / `amount_spent` / `balance`, treats `spend_cap: 0` as **no cap set**
(otherwise "no limit configured" and "limit reached" read identically), and never
reports negative headroom. The ৳500 code gate is reported next to Meta's own
ceiling, and the tool now tells the head **not** to offer to remember a cap Boss
states — a money limit lives in code, not in memory.

**A regression I caused and fixed.** The first preview run after phase C came
back `An unexpected error has occurred` — Graph's generic transient/limit error —
on a path already making two insights calls per campaign plus a per-campaign
`/adsets` lookup. The phase-A structure read already fetches every ad set in the
account, so it now carries their daily budgets too and **replaces** that
per-campaign lookup: two account-level calls do the work of N, and the net call
count is lower than before this branch started.

---

## Verification status — honest

| | |
|---|---|
| unit tests | **green** — 27 in `src/agent/lib/ads`, 21 in the bridge, 142 in the skill engine |
| typecheck | clean (the pre-existing `sip.js` gap in `useSoftphone.ts` is unrelated and predates this branch) |
| **live proof of A–C** | **DONE**, on the branch preview, against his own account — see below |

Two things blocked the live run, and both are worth writing down:

1. **The branch preview alias served an older build.** The payload from a run at
   15:09 still carried the pre-phase-A message text, while `vercel ls
   --meta githubCommitRef=claude/ads-expert` showed no deployment for the newest
   commits. The project's build queue was busy with other branches at the time.
2. **The GitHub commit status said `success` for a commit that had no branch
   deployment.** So "gh commit status went green" is NOT proof that the alias is
   serving that commit — check `vercel inspect <alias>` against
   `vercel ls --meta githubCommitRef=<branch>` as well. This contradicts the
   shortcut recorded in earlier notes; the shortcut is wrong on a busy queue.

### The live run — 2026-07-27, branch preview, one plain sentence

> `ekhon koyta campaign cholche ar koyta message pacchi`

Tool payload, verbatim:

> *"**2টি ক্যাম্পেইন আসলে চলছে**, সবগুলো এখন hold … আরও 2টি campaign-level ACTIVE
> কিন্তু ডেলিভারি করছে না (ad set/ad বন্ধ): **New Engagement Campaign, For Sale-
> April 13-02 ads**"*

Agent's reply: *"delivering ২টা ক্যাম্পেইন, মোট মেসেজ ২৪৭টা"* with
`deliveringCount=2, messages=247, stalled=2, source=Meta MCP + Graph API`.

| checked against | result |
|---|---|
| Boss's own count in Ads Manager (2) | **matches** |
| the two he named as active | **matches** — the two the tool calls stalled are exactly the two he did NOT name |
| "কত মেসেজ পাচ্ছি" (impossible before phase B) | **247**, from `actions` |
| `accountLimits` in the payload (phase C) | present |

**Found while watching the rest of the screen**, neither caused by this branch:

1. The reply opened with *"ঠিক আছে Boss —"*, the opener he banned.
2. The `ask_user` call was rendered as a raw `ASK_USER` block of
   `<parameter name="options">…` lines inside the message — the same
   tool-call-as-text leak `HANDOFF.md` §2b records for Qwen, now on Grok 4.20.

---

## What ADS-2 does NOT fix

The ADS-1 finding still stands and is untouched by any of this: on 2026-07-27 the
head reported fabricated campaign numbers while a correct tool payload sat in the
same turn. Better data does not stop a model from ignoring it. That check belongs
in code, next to `claim-verifier.ts`, and it should land before any write tool is
considered.
