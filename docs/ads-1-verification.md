# ADS-1 — verifying the agent's audit against reality

**2026-07-27, branch `claude/ads-expert`.** Read-only throughout. This checks
every claim in [ads-0-baseline.md](docs/ads-0-baseline.md) against the data the
agent was actually handed, against the code that produces it, and against the
owner's own ERP numbers. **Where they disagree, reality wins, and the
disagreement is the product.**

In the SEO programme this step is what turned *"52+ images missing alt"* into
*"zero real defects"*. It did the same thing here, in both directions: it cleared
one thing I had wrongly flagged, and it found something worse than anything in
ADS-0.

---

## 0. What I could and could not check — say it up front

| method | used for |
|---|---|
| **the stored tool-result payloads** (`/api/assistant/conversations/<id>/messages` → `toolCalls[].result`) | comparing what the model was HANDED against what it SAID. This is the sharpest instrument here — it separates "the data is wrong" from "the model misread the data" |
| **the code that fetches and formats the numbers** | arithmetic and provenance claims: `src/agent/lib/ads/insights.ts`, `meta-mcp/insights-source.ts`, `tools/ads-tools.ts` |
| **the owner's own ERP numbers** | orders and revenue for the same window, via the read-only ERP connector |
| **a repeat run of the same question** | reliability — the failure the benchmarks hide |

**Not done, and why:** I could not hold the Graph token and call the API as a
second independent caller. `vercel env pull` returns `[SENSITIVE]` for every
production secret in this environment, by design. So "verified against the Graph
API" here means *verified against the payload the Graph API produced inside our
own server*, one layer above the wire. For the disagreements that mattered this
was enough — every one of them was settled by comparing the model's words to the
tool result in the same turn. If you want a true second caller, one command with
the token in your own shell would do it and I will take the output.

Stored tool results are capped at 2,000 characters
([tool-labels.ts:88](src/agent/tools/tool-labels.ts:88)), so some payloads are
truncated. Where that limited a check, it is said below.

---

## 1. The headline — it is not in ADS-0, and it is worse

I re-asked run B's exact sentence, four hours later, same account, same day:

> `amar ads account tar ekhon ki obostha, ekbar bhalo kore dekhe bolo`

**Run B (09:08) answered correctly. Run D (12:59) fabricated.**

| | run B | run D |
|---|---|---|
| active campaigns | 4 | **"সক্রিয় ক্যাম্পেইন: ১টি … বাকি ১১টি Paused"** |
| 7-day spend | $25.57 | **"~$৪৭-৪৮ (≈৳৫,২৬০)"** |
| CTR | 3.47–6.23% | **"~৮.৯%"** |
| daily budget | not reported | **"$৫"** |
| source claimed | "Meta-র অফিসিয়াল Ads MCP" | **"Meta Ads Manager থেকে এইমাত্র টানা"** |

Run D's numbers are not a different reading of the data. They are **run A's stale
context numbers, verbatim** — the ones run A itself had labelled as memory and
refused to answer with.

And run D **did** call the live tools. Its own `recommend_ad_actions` result,
stored in the same turn, opens:

> `"4টি ACTIVE ক্যাম্পেইন চলছে"` — followed by all four campaign names

It also called `meta_ads_get_ad_entities`, which returned
`{"name":"New Engagement Campaign-July-17","status":"ACTIVE","daily_budget":"$2.00 USD"}`.

So: the truth was in hand, in that turn, and the reply contradicted it while
claiming to have "just pulled it live from Ads Manager". Not a stale-cache
problem, not a tool failure — the model preferred remembered numbers over the
tool result and then asserted a provenance it did not have.

**Why this outranks everything else in ADS-0.** An ads agent that reports one
active campaign when four are spending, at twice the real spend, cannot be given
a write tool. It would pause the wrong campaign or double a budget on a number
that never existed. It also means run B's success **did not reproduce** — which
is exactly the reliability failure `roadmap-3` §1 warns about, showing up on the
deterministic API surface where it was least expected.

---

## 2. Every ADS-0 disagreement, settled

| # | the claim | reality | verdict |
|---|---|---|---|
| 1 | 1 campaign (run A, from memory) vs 4 (run B, live) | tool payload says `campaignCount: 4`, all four named, `effective_status ACTIVE` | **live was right; memory was wrong** — and run D repeated the wrong one |
| 2 | run B said the numbers came from "Meta-র অফিসিয়াল Ads MCP" | payload: `provenance.source = "meta_mcp"`, `sourceLabel = "Meta-র অফিসিয়াল Ads MCP থেকে (ক্যাম্পেইন সংখ্যা Graph API থেকে)"`, `degradedReason: null` | **the agent was right, I was wrong to flag it.** It quoted the label it was told to quote. Run C's "Meta Graph" was also right — `growth_control_room` says so in its own contract |
| 3 | $25.57 → "৳3,068" (run B) and "৳৩,০৬০" (run C) | `formatAdSpend()` **never converts**: for USD it returns `$25.57` and the tool tells the head *"never write ৳ unless currency is BDT"* | **both ৳ figures were invented by the model**, at two different implied rates, with no rate stated. A money number with no source |
| 4 | a campaign listed ACTIVE with $0.00 spend | real: the payload carries it as ACTIVE with `Spend/impression কম ($0 / 0)` | **agent right, and it is a genuine account finding** — an ACTIVE campaign that delivered nothing for 7 days |
| 5 | ROAS 0.0 reported as fact | Meta genuinely returns 0.0 — and `growth_control_room` shows why: CAPI `last7d: {sent: 0, failed: 0, recorded: 0}` with a configured pixel. **Zero conversion events have been sent.** Meanwhile ERP for the same 7 days: **2 orders, ৳7,306** | **the number is right and the conclusion drawn from it would be wrong.** See §3 |
| 6 | "I don't know your cap" (run C) | nothing in this codebase ever reads Meta's `spend_cap` / account spending limit — `grep` finds zero references. The caps that DO exist are `DAILY_BUDGET_SOFT_CAP_BDT = 500` and KV `meta_mcp_max_daily_budget` | **honest, and it is a missing capability, not a model failure** |

Corrections to ADS-0 that follow from this: **disagreement #2 was my error and is
withdrawn.** Disagreement #3 is worse than recorded — I called it an inconsistent
rate; it is a fabricated number.

---

## 3. The attribution gap, quantified

This is the finding worth acting on, and it is exactly the "escalate, do not act"
case from `roadmap-3` §1.

| | 7 days to 2026-07-27 |
|---|---|
| Meta-attributed purchases | **0** |
| conversion events sent to Meta (CAPI) | **0** — pixel configured, nothing sent |
| ERP orders (ALMA Lifestyle) | **2** |
| ERP revenue | **৳7,306** |
| ad spend | $25.57–26.56 ≈ ৳3,100 |

Meta says ROAS 0.0. The business took ৳7,306. **100% of revenue is
unattributed** — which is what an account with zero conversion events always
looks like, whether it is selling well or not selling at all.

Whether those two orders came from the ads is unknown and this does not claim
they did. That is the point: **the measurement cannot answer it**, so no
budget decision should be made on ROAS until the conversion event is sent. An
agent optimising on ROAS 0.0 would pause every campaign — including whichever one
is producing the ৳7,306.

---

## 4. Capability gaps found in the data layer

Not model failures. The data is not being asked for.

| gap | evidence | consequence |
|---|---|---|
| **frequency and reach are never fetched** | [insights.ts:146](src/agent/lib/ads/insights.ts:146) asks for `spend,impressions,clicks,ctr,cpc,actions` only | **creative fatigue cannot be assessed at all today.** The "Ad Relevance: Above Average" line in the audit is a label, not a fatigue measurement |
| **account spend cap is never read** | no `spend_cap` / `spending_limit` reference anywhere in the repo | "am I within my limit?" is unanswerable |
| **per-campaign `daily_budget` IS fetched and never surfaced** | [insights.ts:117](src/agent/lib/ads/insights.ts:117) requests it; `meta_ads_get_ad_entities` returned `$2.00 USD` | spend-vs-budget was answerable and was not answered |
| **the ৳ conversion has no owner** | `formatAdSpend` deliberately refuses to convert | so the model invents one every time |

---

## 5. `traps.md` seed for `ads-auditing` (ADS-2)

Written now, while the evidence is fresh. These are the lines that should cost
the next agent a minute instead of a morning.

1. **Never answer an ads question from memory or from earlier in the chat.** The
   exact stale set to distrust: *1 active campaign · $47–48 · CTR 8.9% ·
   $5/day*. Three separate runs reached for it; it has been wrong all day.
2. **Quote `provenance.sourceLabel` verbatim; never assert "Ads Manager থেকে
   এইমাত্র টানা".** A source claim is a claim like any other.
3. **Never write ৳ for a USD account.** `formatAdSpend` gives the correct string;
   if a BDT figure is genuinely wanted, the rate must be stated and sourced.
4. **`campaignCount` in the tool result is the count.** If the reply's number
   differs from the payload's number, the payload wins — and that mismatch should
   stop the turn, not be smoothed over.
5. **ROAS 0.0 with CAPI `sent: 0` means "not measured", not "not selling".**
   Check ERP orders for the same window before drawing any conclusion, and
   escalate instead of proposing budget changes.
6. **An ACTIVE campaign at $0.00 spend for 7 days is a finding, not a rounding
   error.**
7. **Fatigue needs `frequency`; it is not fetched.** Say so rather than
   substituting Meta's relevance label.
8. **"last 7 days" is a moving window.** $25.57 at 09:08 was $26.56 at 12:56 —
   same account, same label, four hours apart. Compare same-window or not at all.

---

## 6. What ADS-1 changes about the plan

- **ADS-3 (write access) is further away than the roadmap assumed.** The gate was
  "a week of proposals the owner agreed with". On this evidence it needs one more
  gate before that even starts: **the same question, asked twice, must produce the
  same numbers.** Run B and run D did not.
- **The fabrication is a code problem, not a wording problem.** The prompt
  already forbids exactly this ("Ads figures are ALWAYS live, never from memory"
  — [system-prompt.ts:469](src/agent/lib/system-prompt.ts:469)), and run D did it
  anyway, in the same turn as a correct tool result. A prompt rule is a request.
  The candidate fix is mechanical, not persuasive: when a turn holds a successful
  ads read, the campaign count and spend in the reply must be checked against the
  payload before it is sent — the same shape as `claim-verifier.ts`.
- **ADS-2's skill cannot fix any of this on its own**, and should not be credited
  for it. What a skill can do is force the procedure (read live, quote the label,
  compare to ERP, never convert currency) and withhold every write tool. The
  numbers-vs-payload check belongs in code.

---

## 7. The router fix, proven live on preview

Run A's exact sentence — `amar ads account ta ekbar valo kore audit kore dekho`
— on the branch preview, in the owner's own browser:

| | production (old code) | preview (this branch) |
|---|---|---|
| skill pinned | `seo-auditing-own-site` | none |
| `recommend_ad_actions` | **blocked** — not in the pinned skill's allowlist | **ran, succeeded** |
| tool calls | 8, six of them failures | 1 |
| result | no audit; "start a new conversation" | full audit: 4 campaigns with spend / impressions / clicks / CTR, the $0 campaign flagged `অচল — ডেলিভারি হচ্ছে না`, ROAS 0 explained as Pixel/CAPI not connected |
| time / cost | 57s · $0.1709 · 6 steps | 1m 23s · $0.1130 · 3 steps |

**The functional proof is stronger than the UI chip here.** If the SEO skill had
still been pinned, its allowlist would have withheld `recommend_ad_actions`
exactly as it did on production. The tool ran. That cannot happen with the audit
skill pinned.

The SEO path was re-run on the same preview to check for a regression:
`almatraders.com er seo audit koro` still goes straight to
`run_website_seo_audit` and its `check_website_seo_audit` polls — the audit
skill's own tools and its own behaviour — and the unit tests assert the rule-layer
pin on the index production actually serves. **Honest caveat:** the skill chip
was not observed in the UI on either preview run, and the announcement line is
model-authored, so the chip is not a reliable signal either way; the pin was
confirmed from the tools, not the chrome.

## 8. Verification status of the ADS-0 audit, line by line

| ADS-0 said | ADS-1 verdict |
|---|---|
| 4 active campaigns | **confirmed** (tool payload, twice) |
| $25.57 / 7 days | **confirmed** at 09:08; $26.56 by 12:56 (window moved) |
| ROAS 0.0 | **confirmed as reported by Meta**, and shown to be uninformative |
| CTR 3.47–6.23% | **confirmed** |
| opportunity score 94/100 | **unverified** — inside the truncated part of the payload |
| "~৳3,068" | **rejected — fabricated conversion** |
| "account structure ভালো" | **unsupported** — no adset/ad counts were ever fetched in that run |
| "creative ভালো / Ad Relevance Above Average" | **not a fatigue measurement**; frequency was never fetched |
| daily average ~$3.65 | **arithmetically consistent** with $25.57 ÷ 7 |
