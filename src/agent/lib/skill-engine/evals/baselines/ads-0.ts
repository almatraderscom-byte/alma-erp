/**
 * ADS-0 — the NO-SKILL BASELINE, recorded 2026-07-27 from three live runs on
 * production (alma-erp-six.vercel.app) in the owner's own browser.
 *
 * Why this file exists at all: every later claim that "the ads skill helped" is
 * measured against these runs, and a baseline that is not captured at the moment
 * it happens cannot be reconstructed afterwards. Roadmap 2 records the same
 * failure the other way round — the eval harness was built, runs happened, and
 * nobody wrote them down, so there was nothing to score.
 *
 * The tool records are NOT transcribed from the screen. They were read back from
 * `/api/assistant/conversations/<id>/messages`, which returns the real
 * `toolCalls` rows, because the on-screen step labels are a summary and had
 * already misled me once (run C's visible label named a tool that never ran —
 * the model emitted that call as TEXT).
 *
 * Conditions, all part of the measurement:
 *   · production, `modelId: auto` → resolved to Qwen (run A, C) / DeepSeek (B)
 *   · skill engine ON (KV `skill_engine_enabled=true`), 16 originals `draft`
 *   · no ads skill exists yet — nothing to pin for an ads job
 *   · read-only: no write tool ran in any of the three, nothing was staged
 *
 * The full write-up, with the numbers and the screenshots, is
 * `docs/ads-0-baseline.md`.
 */
import type { EvalRun } from '@/agent/lib/skill-engine/evals/scoring'

/** What each run cost and how long it took — not scored, but it is the other
 *  half of "did the skill help" (Roadmap 2 measured the SEO skill this way). */
export interface BaselineCost {
  seconds: number
  usd: number
  steps: number
  /** Head model the auto-router actually resolved to for this run. */
  model: string
  /** The conversation row the record was read back from. */
  conversationId: string
}

export const ADS0_BASELINE_COSTS: Record<string, BaselineCost> = {
  'ads/audit-word': {
    seconds: 57,
    usd: 0.1709,
    steps: 6,
    model: 'qwen',
    conversationId: '774b2646-b5ec-42f7-9d99-41b49136c9da',
  },
  'ads/status-plain': {
    seconds: 118,
    usd: 0.2064,
    steps: 4,
    model: 'or-deepseek-v4-flash',
    conversationId: '0b4638f5-4b98-462a-b6d9-28ff8a62201d',
  },
  'ads/spend-vs-cap': {
    seconds: 56,
    usd: 0.1727,
    steps: 3,
    model: 'qwen',
    conversationId: 'd83b73de-7a06-45fd-a7c2-3efbdd831e37',
  },
}

/**
 * Run A — "amar ads account ta ekbar valo kore audit kore dekho".
 *
 * The word "audit" is enough on its own: `isSeoTopic()` counts a bare `audit` as
 * an SEO marker, so the RULE-layer rule `own-site-audit` pinned
 * `seo-auditing-own-site` — for a question about the ad account. SK-4's
 * allowlist then did exactly what it promises and withheld every ads tool, and
 * `find_tool` (hardened the same week) refused to smuggle them back in. Eight
 * tool calls, six of them failures, no audit, and the agent's own advice to the
 * owner was to start a new conversation.
 */
const RUN_A: EvalRun = {
  pinnedSkill: 'seo-auditing-own-site',
  tools: [
    { toolName: 'recommend_ad_actions', status: 'error' },
    { toolName: 'marketing_capability_audit', status: 'error' },
    { toolName: 'recommend_ad_actions', status: 'error' },
    { toolName: 'get_marketing_history', status: 'error' },
    { toolName: 'find_tool', status: 'success' },
    { toolName: 'find_tool', status: 'success' },
    { toolName: 'marketing_report', status: 'error' },
    { toolName: 'live_browser_act', status: 'error' },
  ],
  replyText: [
    'বস, সোজা কথা — এই টার্নে ads account audit-এর কোনো টুল আমার হাতে নেই।',
    'ফাইন্ড করেছি কিন্তু লোড হয়নি: recommend_ad_actions (campaign performance), marketing_report (weekly funnel report), live_browser_act (Ads Manager directly)।',
    'কিছু ডেটা আছে context-এ (যা আগে check হয়েছিল): Active campaigns ১টা ("For Sale- April 30-03 ads - Copy"), গত ৭ দিনে spend $47-48 (৳5,260), CTR 8.9%, ROAS 0, Daily budget $5।',
    'কিন্তু পুরো audit-এর জন্য দরকার live fresh data — memory থেকে সংখ্যা দেওয়া forbidden, আপনারই নিয়ম।',
    'পরের ধাপ: নতুন conversation শুরু করুন — সেখানে ads tools কাজ করবে। অথবা আপনি নিজে Ads Manager খুলে দেখুন (আমি guide দিতে পারি)।',
  ].join('\n'),
}

/**
 * Run B — the same question with the word "audit" removed. No skill pinned, one
 * successful ads read, and a real readout: 4 ACTIVE campaigns, $25.57 over 7
 * days, ROAS 0.0, CTR 3.47–6.23%, Meta opportunity score 94/100.
 *
 * This is the run an `ads-auditing` skill has to beat. Note what it did NOT do:
 * no adset/ad counts (structure was asserted, not counted), no frequency (so no
 * real creative-fatigue read), no spend-vs-cap, and no cross-check of ROAS 0.0
 * against ERP orders.
 */
const RUN_B: EvalRun = {
  pinnedSkill: null,
  tools: [{ toolName: 'recommend_ad_actions', status: 'success' }],
  replyText: [
    'বস, আপনার অ্যাডস অ্যাকাউন্টের লাইভ অবস্থা (Meta-র অফিসিয়াল Ads MCP থেকে):',
    'সারসংক্ষেপ: ৪টা ক্যাম্পেইন ACTIVE চলছে। গত ৭ দিনে মোট খরচ $25.57 (~৳3,068)। ROAS 0.0x — কোনো conversion track হচ্ছে না। CTR ভালো: 3.47% - 6.23%। Meta Opportunity Score: 94/100 — account healthy।',
    'ক্যাম্পেইন ভিত্তিক: For Sale- April 13-02 ads $6.19 / 3.47% / ACTIVE; For Sale- April 30-03 ads - Copy $9.68 / 6.23% / ACTIVE; New Engagement Campaign-July-17 $9.70 / 4.03% / ACTIVE; New Engagement Campaign $0.00 / 0% / ACTIVE।',
    'সমস্যা: মানুষ click করছে কিন্তু conversion track হচ্ছে না। Ad Relevance: Above Average। ROAS 0.0 মানে money waste হচ্ছে।',
    'আপনার অ্যাকাউন্ট structure ভালো, ad quality-তে সমস্যা নেই — শুধু conversion tracking-এ গ্যাপ আছে।',
  ].join('\n'),
}

/**
 * Run C — "roj koto kharoch hocche ar limit er moddhe achi kina".
 *
 * Two things worth keeping. First, the answer came from `growth_control_room`,
 * not the ads tool: the model wrote its `recommend_ad_actions` call as literal
 * JSON text into the reply, so that call never executed — the leak IS the
 * failure, not just cosmetics. Second, on the actual question it was honest and
 * empty-handed: it does not know the cap. The cap exists in code
 * (`DAILY_BUDGET_SOFT_CAP_BDT = 500`, `meta_mcp_max_daily_budget`) and Meta
 * exposes the account spend limit — it consulted neither, and instead offered to
 * SAVE a cap the owner tells it, which is the money-gate-in-memory anti-pattern
 * this programme exists to prevent.
 */
const RUN_C: EvalRun = {
  pinnedSkill: null,
  tools: [{ toolName: 'growth_control_room', status: 'success' }],
  replyText: [
    '{"type": "tool_use", "id": "tooluse_fPsTqJdFhXJz8Qm9Kw2LxN", "name": "recommend_ad_actions", "input": {}}',
    'বস, গত ৭ দিনের অ্যাড খরচ (Meta Graph থেকে লাইভ): মোট খরচ $25.57 USD (≈৳৩,০৬০), রোজ গড় ~$3.65/দিন (≈৳৪৩৮)।',
    'ক্যাম্পেইন-ভিত্তিক: For Sale- April 30-03 ads - Copy $9.68 / 6.23% / Active; New Engagement Campaign-July-17 $9.70 / 4.04% / Active; For Sale- April 13-02 ads $6.19 / 3.47% / Active।',
    'লিমিট নিয়ে সৎ কথা: আপনার account-level daily spending limit কত সেটা আমার কাছে সেভ করা নেই, আর কোনো approved growth brief-ও নেই। তবে $3.65/day গড় খরচ বেশ modest।',
    'আপনি যদি আপনার নির্দিষ্ট daily cap টা বলেন, সেটা আমার কাছে save করে রাখব।',
    'একটা পর্যবেক্ষণ: April 30 ক্যাম্পেইনটা অন্য দুটোর চেয়ে প্রায় দ্বিগুণ ভালো পারফর্ম করছে — budget বাড়ানো বা duplicate করার সুযোগ আছে।',
  ].join('\n'),
}

/** Keyed by scenario id, so `scoreRun` can pair them without a lookup table. */
export const ADS0_BASELINE_RUNS: Record<string, EvalRun> = {
  'ads/audit-word': RUN_A,
  'ads/status-plain': RUN_B,
  'ads/spend-vs-cap': RUN_C,
}
