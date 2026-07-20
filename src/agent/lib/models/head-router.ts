/**
 * Cheap triage head (Phase 1 cost optimisation).
 *
 * Today every owner message is answered by Sonnet — even "aj koto sale" or a
 * thank-you. In a small office (2-5 staff) most traffic is routine, so paying
 * Sonnet rates on all of it is the single biggest cost. This module runs a tiny,
 * near-free triage classifier (DeepSeek) BEFORE the turn and routes:
 *   - light  → a cheap head (DeepSeek) runs the full agent loop (tools, ERP reads,
 *              staff/CS info, casual). Mutating actions still go through the owner's
 *              approval cards, so a misread can't move money.
 *   - heavy  → Sonnet, as before (money decisions, finance writes, planning/strategy,
 *              marketing substance, anything sensitive or ambiguous).
 *
 * Safety posture: fail HEAVY. Any uncertainty, any error, missing key, personal or
 * trading context, or a dangerous keyword → Sonnet. The owner can disable the whole
 * thing with ENABLE_CHEAP_HEAD=false, or swap models via CHEAP_HEAD_MODEL_ID /
 * CHEAP_HEAD_TRIAGE_MODEL_ID without a code change.
 */
import OpenAI from 'openai'
import { AUTO_MODEL_ID, DEFAULT_MODEL_ID, getModel, isKnownModelId } from '@/agent/lib/models/registry'
import { calcModelTurnCostUsd } from '@/agent/lib/models/cost'
import { logCost } from '@/agent/lib/cost-events'
import { prisma } from '@/lib/prisma'
import { isOutboundCallIntent } from '@/agent/lib/outbound-call-intent'
import { isModelEnabled } from '@/agent/lib/models/model-enabled'
import { getDefaultHeadModelId } from '@/agent/lib/models/routing-config'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'

export type HeadTier = 'light' | 'heavy' | 'explicit' | 'marketing' | 'personal'

export interface HeadDecision {
  modelId: string
  tier: HeadTier
  /** Why this head was chosen — surfaced in cost logs for tuning. */
  via: string
}

const cheapHeadEnabled = (): boolean => process.env.ENABLE_CHEAP_HEAD !== 'false'
const cheapHeadModelId = (): string => process.env.CHEAP_HEAD_MODEL_ID?.trim() || 'or-deepseek-v4-flash'
const triageModelId = (): string => process.env.CHEAP_HEAD_TRIAGE_MODEL_ID?.trim() || 'or-deepseek-v4-flash'

// Heavy/sensitive head model. Owner command (2026-07): Anthropic credits exhausted,
// so the heavy tier answers on Gemini 3.1 Pro instead of the dead Sonnet head.
// Owner-tunable via HEAVY_HEAD_MODEL_ID (no redeploy). Falls back to DEFAULT_MODEL_ID
// only if the configured id is unknown — DEFAULT_MODEL_ID itself stays Claude because
// it guards the finance/CRITICAL sub-agent path, which is separate from the head.
// Owner rule 2026-07-18: Gemini head OFF, Grok 4.20 is the head. The heavy/sensitive
// tier (auto-mode) + the ANTHROPIC_HEAD_DOWN redirect now land on Grok by default.
// `fallback` lets resolveHeadModelId pass the owner's KV-tuned default head so a live
// change (no redeploy) also moves the heavy tier; HEAVY_HEAD_MODEL_ID env still wins.
export const heavyHeadModelId = (fallback = 'xai-grok-4.20'): string => {
  const id = process.env.HEAVY_HEAD_MODEL_ID?.trim() || fallback
  return isKnownModelId(id) ? id : DEFAULT_MODEL_ID
}

// NOTE: ANTHROPIC_HEAD_DOWN no longer gates the owner's EXPLICIT model pick — the
// Monitor toggle is the single owner-facing switch for that (see resolveHeadModelId).
// The env flag still lives in model-enabled.ts::isAnthropicAllowed, which governs the
// AUTO/heavy tier + background subsystems (cs, morale, digests) — those keep failing to
// Gemini while it is truthy. Owner rule 2026-07-20: don't reintroduce it on the pick path.

// Marketing head: when the owner's message is marketing/content work, Qwen answers
// DIRECTLY as the head (runs the full agent loop) — exactly like DeepSeek does for
// "light" turns. No Sonnet→sub-agent hop, so no double token cost. Owner-tunable.
const marketingHeadEnabled = (): boolean => process.env.ENABLE_MARKETING_HEAD !== 'false'
const marketingHeadModelId = (): string => process.env.MARKETING_HEAD_MODEL_ID?.trim() || 'or-qwen3-max'

/**
 * Marketing / content-writing intent (Bangla + Banglish + English). Caption, FB/social
 * post, ad copy, campaign, promotion, creative drafting. Kept narrow on PURPOSE — only
 * the message text decides; money keywords (handled by HEAVY_DENY_RE above) still win and
 * force Sonnet, and every money/posting/ad-spend tool inside keeps its own approval card.
 */
const MARKETING_RE = new RegExp(
  [
    'marketing|মার্কেটিং',
    'caption|ক্যাপশন|ক্যাপশান',
    'বিজ্ঞাপন|\\bads?\\b|\\bboost|বুস্ট',
    'campaign|ক্যাম্পেইন|promotion|প্রমোশন|প্রচার',
    'creative|ক্রিয়েটিভ|copywrit|কপি\\s*(লিখ|বানা)',
    // Bangla "post" is high-precision in this assistant; plus FB/social near "post"
    'ফেসবুক\\s*পোস্ট|পোস্ট',
    '(facebook|fb|social|insta|ফেসবুক)\\b[^\\n]{0,15}\\bpost',
    '\\bpost\\b[^\\n]{0,15}(facebook|fb|social|insta|ফেসবুক)',
    // "post" + a make/give/write/ready verb (Banglish + English) — catches the
    // natural phrasings that the old adjacency-only regex silently missed
    // (e.g. "post banao", "post kore dao", "post ready koro", "post likhe dao").
    '\\bpost\\b[^\\n]{0,20}\\b(banao|banaw|bana|baniye|banai|dao|dibe|den|lekho|likhe|likho|ready|redi|kore|koro|lagbe|lage|chai)\\b',
    '\\b(banao|banaw|bana|baniye|lekho|likhe|likho)\\b[^\\n]{0,12}\\bpost\\b',
  ].join('|'),
  'i',
)

/**
 * Routine status lookups the owner asks many times a day — today's sales, who is
 * present in the office, stock / order / pending counts. These are pure ERP reads,
 * low-stakes, and the single highest-frequency traffic. FAST PATH: an obvious routine
 * phrase (regex) routes straight to the cheap head (DeepSeek) and SKIPS the triage
 * call entirely — guaranteed routing + one less paid classifier hop. Money keywords
 * (HEAVY_DENY_RE) are checked first and still force Sonnet, and every mutating tool
 * keeps its own approval card, so a cheap read can never move money. Owner-tunable
 * via ENABLE_CHEAP_HEAD / CHEAP_HEAD_MODEL_ID.
 */
const ROUTINE_RE = new RegExp(
  [
    // today's sales / revenue
    '(aj|ajk|ajke|আজ|আজকে)[^\\n]{0,20}(sell|sale|sales|bikri|বিক্রি|বিক্রয়|সেল|revenue|আয়|koto\\s*holo|koto\\s*hoyeche)',
    '(koto|কত)[^\\n]{0,12}(sell|sale|bikri|বিক্রি|সেল)',
    // who is present / attendance / in office. Word-bounded (2026-07-14 fix):
    // bare 'ke'/'ase' matched INSIDE words ("keno ... ase?" → false routine hit,
    // masked until the structured-output change exposed it in tests). Latin tokens
    // get \b; Bangla কে gets the (?![ঀ-ৼ]) no-more-Bangla-letters guard used
    // elsewhere (turn-loop-policy) since \b doesn't understand Bangla script.
    '(\\bke\\b|কে(?![ঀ-ৼ])|\\bkara\\b|কারা)[^\\n]{0,20}(office|অফিস|\\base\\b|আছে|present|উপস্থিত|hajir|হাজির|check\\s*in|checkin|checked\\s*in)',
    'attendance|হাজিরা|উপস্থিতি|\\bke\\s*ke\\s*ase\\b',
    // stock / inventory counts
    'stock|স্টক|মজুদ|inventory|koto\\s*pcs|koto\\s*piece',
    // order / pending counts
    '(koto|কত|how\\s*many)[^\\n]{0,12}(order|অর্ডার|pending|পেন্ডিং|delivery|ডেলিভারি)',
    '(order|অর্ডার|pending|পেন্ডিং)[^\\n]{0,12}(koto|কত|count|সংখ্যা)',
    // ── LG-1 routine-graph intents (2026-07-15): these phrasings must reach the
    // light head deterministically or the graph never sees them. All read-only;
    // HEAVY_DENY_RE (money/destructive) is still checked before this regex.
    // today's expense (today-word required — period questions stay on triage)
    '(\\baj\\b|\\bajke\\b|\\bajker\\b|আজ|আজকে|আজকের|\\btoday\\b)[^\\n]{0,24}(khoroch|kharoch|খরচ|expense)',
    '(khoroch|kharoch|খরচ|expense)[^\\n]{0,24}(\\baj\\b|\\bajke\\b|\\bajker\\b|আজ|আজকে|আজকের|\\btoday\\b)',
    // staff task status (assignment commands like "task dao" don\'t match)
    '(ki|কি|কী|kon|কোন)\\s*(task|টাস্ক)',
    '(task|টাস্ক)[^\\n]{0,14}(dise|dice|দিছে|দিয়েছে|dewa|দেওয়া|status|স্ট্যাটাস|hoise|হয়েছে)',
    // salah/waqt times (a time word is required)
    '(namaz|namaj|নামাজ|নামায|salah|salat|সালাত|ছালাত)[^\\n]{0,16}(somoy|সময়|time|টাইম|schedule|সূচি|waqt|ওয়াক্ত|kokhon|কখন|koyta|কয়টা|কটায়)',
    // pending approvals
    '(approval|অ্যাপ্রুভাল|এপ্রুভাল|onumodon|অনুমোদন)[^\\n]{0,14}(pending|পেন্ডিং|baki|বাকি|koto|কত|ache|আছে|\\base\\b)',
    '(pending|পেন্ডিং)[^\\n]{0,12}(approval|অ্যাপ্রুভাল|এপ্রুভাল|অনুমোদন|card|কার্ড)',
    // order status by number ("order 1234 kothay", "#ALM-1234 status") — a
    // status word is REQUIRED so "order 500 pcs ano" (a command) never routes here
    '(order|অর্ডার|invoice|#)\\s*#?\\s*[A-Za-z]{0,6}-?\\d{3,12}[^\\n]{0,24}(status|স্ট্যাটাস|obostha|অবস্থা|kothay|কোথায়|koi|কই|update|আপডেট|hoise|হয়েছে|deliver|ডেলিভার|কতদূর)',
    // LG-3: single expense log ("500 taka khoroch holo") — the cheap head owns
    // this today (log_expense card); LG-3 makes it a deterministic light route.
    '([০-৯\\d][০-৯\\d,]*)\\s*(taka|tk|টাকা|৳)[^\\n]{0,24}(khoroch|খরচ)',
    '(khoroch|খরচ)[^\\n]{0,24}([০-৯\\d][০-৯\\d,]*)\\s*(taka|tk|টাকা|৳)',
  ].join('|'),
  'i',
)

// Personal-empathy mode kill switch (owner-tunable, default ON). When the owner
// shares HIS OWN feelings ("mon valo nei", "hotash lagche") in a work chat, the
// head must LISTEN — not treat it as a business command and run tools. Set
// ENABLE_PERSONAL_EMPATHY_MODE=false to disable.
const personalEmpathyEnabled = (): boolean => process.env.ENABLE_PERSONAL_EMPATHY_MODE !== 'false'

/**
 * CHEAP first-pass HINT that a message might be the owner sharing his own
 * feelings / mood / mental state (Bangla + Banglish + English). Deliberately a
 * recall-oriented net, NOT the decision: a match only triggers the confirming
 * classifier below, so normal work traffic (which won't match) pays nothing and
 * the accuracy ("my feelings" vs "customer is upset" vs "feeling + do this task")
 * is decided by the classifier, never by keywords alone.
 */
const PERSONAL_EMOTION_RE = new RegExp(
  [
    'hotash|হতাশ|নিরাশ|hopeless|depress|বিষণ্ণ|বিমর্ষ|frustrated',
    'mon\\s*(kharap|kharab|খারাপ|bhalo\\s*na|valo\\s*na|valo\\s*nei|bhalo\\s*nei|ভালো\\s*ন|bosche\\s*na|বসছে\\s*না)',
    'মন\\s*(খারাপ|ভালো\\s*ন|বসছে\\s*না|ভারী)',
    '(kichu|kono\\s*kichu|কিছু(তে)?)\\s*(i\\s*)?(bhalo|valo|ভালো)\\s*lag',
    '(bhalo|valo|ভালো)\\s*lag(che|ছে|e)?\\s*na|ভালো\\s*লাগছে\\s*না',
    'kanna|কাঁদ|কান্না|crying|kadte\\s*iche',
    '(eka|একা|nihshongo|নিঃসঙ্গ)\\s*(lag|feel|লাগ)|lonely',
    'clanto|ক্লান্ত|obosonno|অবসন্ন|exhausted|hapiye',
    'ghum\\s*(hocche|hoy|asche)?\\s*na|ঘুম\\s*(হচ্ছে|আসছে)?\\s*না|can\\W?t\\s*sleep',
    'ভালো\\s*নেই|valo\\s*nei|bhalo\\s*nei',
    'kosto\\s*(hocche|lagche|pacchi|hoy)|কষ্ট\\s*(হচ্ছে|লাগছে|পাচ্ছি)',
    '(khub|খুব|onek|অনেক)\\s*(chinta|চিন্তা|tension|টেনশন|stress|osthir|অস্থির)',
    'nijeke\\s*(kharap|eka|osohay)|নিজেকে\\s*(খারাপ|একা|অসহায়)',
  ].join('|'),
  'i',
)

const CLASSIFY_PERSONAL_SYSTEM =
  'You classify ONE message a small-business owner sent to his assistant. ' +
  'Messages are often Banglish (Bangla written in English letters). ' +
  'Answer "personal" ONLY if the owner is expressing HIS OWN feelings, mood, emotional or mental state, ' +
  'or personal well-being — e.g. feeling low, hopeless, sad, lonely, anxious, tired, "mon valo nei", ' +
  '"kichu valo lage na", venting, or simply saying he is not okay — AND he is NOT asking for any ' +
  'business or work task in the same message. ' +
  'Answer "work" for everything else: business questions or tasks, orders, marketing, staff, money, ' +
  'status lookups, OR an emotion that is ABOUT someone else (a customer/staff being upset), ' +
  'OR any message that mixes a feeling with a concrete work request. ' +
  'When unsure, answer "work". Answer as JSON: {"classification":"personal"} or {"classification":"work"}.'

/**
 * Shared classifier call with PROVIDER-ENFORCED structured output — OpenRouter
 * `response_format: json_schema` (strict) constrains the model to the schema at
 * decode time, replacing the old "hope the model emits exactly one word, then
 * substring-match it" parsing (the misroute class). If the routed host rejects
 * the parameter, retry once WITHOUT it — the legacy keyword net below still
 * parses a plain-word reply, so classification degrades instead of failing the
 * turn. Returns the raw content string ('' on any error → caller fail-safes).
 */
async function classifierCompletion(opts: {
  client: OpenAI
  system: string
  text: string
  schemaName: string
  schema: Record<string, unknown>
  via: string
  conversationId?: string
}): Promise<string> {
  const model = getModel(triageModelId())
  const base = {
    model: model.apiModel,
    max_tokens: 24,
    temperature: 0,
    messages: [
      { role: 'system' as const, content: opts.system },
      { role: 'user' as const, content: opts.text.slice(0, 1500) },
    ],
  }
  const structured = {
    ...base,
    response_format: {
      type: 'json_schema' as const,
      json_schema: { name: opts.schemaName, strict: true, schema: opts.schema },
    },
  }
  const reqOptions = { signal: AbortSignal.timeout(8000) }
  let resp
  try {
    resp = await opts.client.chat.completions.create(structured, reqOptions)
  } catch (err) {
    console.warn(
      `[head-router] ${opts.via} structured output rejected → plain retry:`,
      err instanceof Error ? err.message : err,
    )
    resp = await opts.client.chat.completions.create(base, reqOptions)
  }
  const usage = resp.usage
  if (usage) {
    void logCost({
      provider: 'openai',
      kind: 'chat',
      units: {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        model: model.id,
        via: opts.via,
      },
      costUsd: calcModelTurnCostUsd(model, {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
      }),
      conversationId: opts.conversationId ?? null,
      dedupKey: `${opts.via}:${opts.conversationId ?? 'na'}:${Date.now()}`,
    }).catch(() => {})
  }
  return resp.choices[0]?.message?.content ?? ''
}

/** Parse a strict-schema classifier reply; null when it isn't the expected JSON. */
function parseClassifierField(content: string, field: string): string | null {
  try {
    const obj = JSON.parse(content) as Record<string, unknown>
    const v = obj?.[field]
    return typeof v === 'string' && v ? v : null
  } catch {
    return null
  }
}

/**
 * Confirm (via the cheap triage model) whether an emotion-hinted message is the
 * owner sharing his OWN feelings with no work ask. Returns false on any doubt,
 * error, or missing key — so a work message is NEVER misrouted into listen mode
 * (owner rule 2026-07-14: the agent must accurately tell "I'm emotional" from
 * "do this work", and err toward work).
 */
async function classifyIsPersonalEmotional(text: string, conversationId?: string): Promise<boolean> {
  const client = openRouterClient()
  if (!client) return false
  try {
    const content = await classifierCompletion({
      client,
      system: CLASSIFY_PERSONAL_SYSTEM,
      text,
      schemaName: 'personal_classification',
      schema: {
        type: 'object',
        properties: { classification: { type: 'string', enum: ['personal', 'work'] } },
        required: ['classification'],
        additionalProperties: false,
      },
      via: 'personal-classify',
      conversationId,
    })
    const parsed = parseClassifierField(content, 'classification')
    if (parsed) return parsed === 'personal'
    // Legacy keyword net for plain-word replies (provider without structured output).
    const out = content.toLowerCase()
    return out.includes('personal') && !out.includes('work')
  } catch (err) {
    console.warn('[head-router] personal-emotional classify failed → work:', err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * Irreversible / high-stakes signals that must ALWAYS get Sonnet — we don't even
 * spend a triage call on these. Bilingual (Bangla + Banglish + English).
 */
const HEAVY_DENY_RE =
  /(delete|remove|মুছে|বাদ\s*দাও|ডিলিট|payroll|salary|বেতন|বোনাস|bonus|ছাঁটাই|বরখাস্ত|terminate|fire\s|loan|ধার|ঋণ|investment|বিনিয়োগ|refund|ফেরত)/i

/**
 * Short follow-up / continuation messages (Rule 1 — thread stickiness). When a
 * conversation is ALREADY being handled by a cheap/marketing head (Qwen/DeepSeek),
 * a keyword-less follow-up like "??", "image koi?", "tarpor", "ok koro" must NOT
 * be re-triaged UP to Sonnet — that per-message jump is the single biggest cost
 * leak (a content thread bounced to Sonnet, then Sonnet ALSO spawned a paid
 * sub-agent → double spend). Such follow-ups inherit the thread's current cheap
 * head. Money/destructive keywords (HEAVY_DENY_RE) still force Sonnet first, so
 * safety is unchanged.
 */
const CONTINUATION_RE = new RegExp(
  '^\\s*(' +
    '\\?+|' +
    '(ok|okay|accha|achha|আচ্ছা|hmm+|hm|ji|জি|hae|হ্যাঁ|ha|হ্যা)\\b|' +
    '(tarpor|tarpore|তারপর|then|next|porer|পরের|erpor|এরপর)\\b|' +
    '(koi|কই|kothay|কোথায়)\\b|' +
    '(ki\\s*(holo|hoilo|hlo|obostha|khobor|hocche|hoise|hoyeche|update|ho))\\b|' +
    '(image|chobi|ছবি|post|পোস্ট)\\s*(ta\\s*)?(koi|kothay|কই|হলো|holo|hoise|hoyeche)' +
  ')',
  'i',
)

/** Below this length a keyword-less message is treated as a continuation/follow-up. */
const CONTINUATION_MAX_LEN = 44

/**
 * LG-4 shadow: PURE re-derivation of the fast-path classification the head
 * router applies before any paid triage call, in the EXACT order decideHead
 * checks them (deny → call → personal-hint → marketing → routine →
 * continuation). Zero I/O, zero model calls — the shadow turn graph runs this
 * on every turn and compares against the live decision's `via`, so the graph's
 * guard topology is scored on real traffic before any cutover.
 * NOTE: 'personal_hint' is the cheap regex HINT only — the live path confirms
 * with a classifier model, so a hint here + non-personal live tier is NOT a
 * mismatch. 'continuation' likewise depends on sticky-thread DB state.
 */
export type HeadFastPathKind =
  | 'deny_kw'
  | 'call_intent'
  | 'personal_hint'
  | 'marketing_kw'
  | 'routine_kw'
  | 'continuation'
  | null

export function classifyHeadFastPath(text: string): HeadFastPathKind {
  const t = (text ?? '').trim()
  if (!t) return null
  if (HEAVY_DENY_RE.test(t)) return 'deny_kw'
  if (isOutboundCallIntent(t)) return 'call_intent'
  if (personalEmpathyEnabled() && PERSONAL_EMOTION_RE.test(t)) return 'personal_hint'
  if (MARKETING_RE.test(t)) return 'marketing_kw'
  if (ROUTINE_RE.test(t)) return 'routine_kw'
  if (t.length <= CONTINUATION_MAX_LEN || CONTINUATION_RE.test(t)) return 'continuation'
  return null
}

/**
 * The head model the conversation last ran on (Rule 1). Read from the most recent
 * assistant message's saved usage.model. Returns null on no history / error so the
 * caller falls back to normal triage. Never throws.
 */
export async function loadStickyHeadModelId(conversationId?: string): Promise<string | null> {
  if (!conversationId) return null
  try {
    const row = await prisma.agentMessage.findFirst({
      where: { conversationId, role: 'assistant' },
      orderBy: { createdAt: 'desc' },
      select: { usage: true },
    })
    const usage = row?.usage as Record<string, unknown> | null | undefined
    const m = usage && typeof usage === 'object' ? usage.model : null
    return typeof m === 'string' && m ? m : null
  } catch (err) {
    console.warn('[head-router] sticky head lookup failed:', err instanceof Error ? err.message : err)
    return null
  }
}

const TRIAGE_SYSTEM =
  'You are a routing classifier for a Bangla small-business assistant (small retail/office; owner is non-technical). ' +
  'Messages are often in Banglish (Bangla written in English letters). ' +
  "Decide who answers the owner's latest message:\n" +
  '- "light": routine, low-stakes, mostly read/lookup or casual — greetings, thanks, acknowledgements, ' +
  'status questions (today\'s sales, who is present, stock/order/pending counts), simple info lookups, ' +
  'simple customer-service info, restating, simple reminders. A cheaper model handles these fine.\n' +
  '- "marketing": anything about social-media marketing or content — writing a Facebook/Instagram post or ' +
  'caption, ad copy, a campaign/promotion idea, product creative, "post banao/likhe dao", boost ideas. ' +
  'A dedicated marketing model handles these.\n' +
  '- "heavy": needs judgment or is sensitive — money decisions, finance write/edit/delete, payroll/salary/staff ' +
  'discipline, multi-step tasks, planning or strategy, asking you to phone/call a person and relay a message ' +
  '(an outbound call, NOT a "remind me" note), or anything ambiguous, unclear, ' +
  'or where a wrong answer costs money or trust.\n' +
  'When unsure between light and heavy, choose "heavy". Answer as JSON: {"tier":"light"}, {"tier":"marketing"}, or {"tier":"heavy"}.'

function openRouterClient(): OpenAI | null {
  const key = process.env.OPENROUTER_API_KEY?.trim()
  if (!key) return null
  const referer = process.env.APP_URL?.replace(/\/$/, '') ?? 'https://alma-erp-six.vercel.app'
  return new OpenAI({
    apiKey: key,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: { 'HTTP-Referer': referer, 'X-Title': 'ALMA ERP Agent (triage)' },
  })
}

async function triageTier(text: string, conversationId?: string): Promise<HeadTier> {
  const client = openRouterClient()
  if (!client) return 'heavy'
  try {
    const content = await classifierCompletion({
      client,
      system: TRIAGE_SYSTEM,
      text,
      schemaName: 'head_triage',
      schema: {
        type: 'object',
        properties: { tier: { type: 'string', enum: ['light', 'marketing', 'heavy'] } },
        required: ['tier'],
        additionalProperties: false,
      },
      via: 'head-triage',
      conversationId,
    })
    const parsed = parseClassifierField(content, 'tier')
    if (parsed === 'marketing' || parsed === 'light' || parsed === 'heavy') return parsed
    // Legacy keyword net for plain-word replies (provider without structured output).
    const out = content.toLowerCase()
    if (out.includes('marketing')) return 'marketing'
    if (out.includes('light')) return 'light'
    return 'heavy'
  } catch (err) {
    console.warn('[head-router] triage failed → heavy:', err instanceof Error ? err.message : err)
    return 'heavy'
  }
}

/**
 * The Qwen marketing-head decision, shared by the regex fast-path and the triage
 * net. Returns null (→ caller falls back) if the marketing head is disabled,
 * unknown, keyless, or misconfigured. Validated the same way as the cheap head.
 */
function marketingHeadDecision(via: string): HeadDecision | null {
  if (!marketingHeadEnabled()) return null
  const qId = marketingHeadModelId()
  if (!isKnownModelId(qId) || !process.env.OPENROUTER_API_KEY?.trim()) return null
  const q = getModel(qId)
  if (q.provider === 'anthropic' || !q.supportsTools) return null
  return { modelId: qId, tier: 'marketing', via }
}

/**
 * The cheap-head (DeepSeek) decision, shared by the routine-query fast-path and the
 * triage "light" branch. Returns null (→ caller falls back to Sonnet) if the cheap
 * head is unknown, Anthropic, or tool-incapable — the same fail-safe as before.
 */
function cheapHeadDecision(via: string): HeadDecision | null {
  const cheapId = cheapHeadModelId()
  if (!isKnownModelId(cheapId)) return null
  const cheap = getModel(cheapId)
  // The cheap head must be a non-Anthropic, tool-capable model (runs via the
  // adapter path). If misconfigured, fail safe to Sonnet.
  if (cheap.provider === 'anthropic' || !cheap.supportsTools) return null
  return { modelId: cheapId, tier: 'light', via }
}

/**
 * Pick the head model for this owner turn. Defaults to Sonnet; only downgrades to
 * the cheap head when triage is confident the turn is routine and safe.
 */
export async function resolveHeadModelId(opts: {
  requestedModelId?: string | null
  lastUserText: string
  personalMode: boolean
  businessId: AgentBusinessId
  conversationId?: string
}): Promise<HeadDecision> {
  // Owner's KV-tuned default head (Grok 4.20 unless changed) — feeds the heavy
  // fallback so a live default-head change also moves auto-mode sensitive turns.
  const kvDefaultHead = await getDefaultHeadModelId()
  const heavy = (via: string): HeadDecision => ({ modelId: heavyHeadModelId(kvDefaultHead), tier: 'heavy', via })

  // Owner's model choice for this conversation:
  //  - a concrete known model id (INCLUDING Sonnet) → run THAT exact model, no triage.
  //    This is what makes "select a model → that real model answers" actually work.
  //  - 'auto' / null / empty → fall through to the triage router below (current cost
  //    behaviour: routine→DeepSeek, marketing→Qwen, sensitive→Sonnet).
  const requested = opts.requestedModelId?.trim()
  if (requested && requested !== AUTO_MODEL_ID && isKnownModelId(requested)) {
    // Explicit Anthropic pick (Opus/Sonnet from the picker). Owner rule 2026-07-20:
    // the Monitor toggle is the ONE owner-facing switch — if the owner has NOT turned
    // the model off in Monitor and picks it in chat, it must RUN. No env flag to hunt
    // down (the old blanket ANTHROPIC_HEAD_DOWN default silently swallowed every Claude
    // pick regardless of balance — that is exactly what this removes). Only two guards,
    // both real necessities, neither owner-config:
    //   - Monitor toggle OFF: the owner's own kill-switch — respect it.
    //   - missing API key   : without ANTHROPIC_API_KEY Claude physically cannot run,
    //                         so redirect instead of hard-400'ing the owner's chat.
    // Either → heavy head; otherwise the explicit Claude head runs below. (If credits
    // ever run out again, the owner flips the model OFF in Monitor — same one switch.)
    if (getModel(requested).provider === 'anthropic') {
      const keyPresent = Boolean(process.env.ANTHROPIC_API_KEY?.trim())
      const monitorOn = await isModelEnabled(requested).catch(() => false)
      if (!keyPresent || !monitorOn) {
        return heavy('anthropic_down_explicit_redirect')
      }
    }
    // Pinning the MARKETING head model (Qwen) must behave as the marketing head,
    // not a generic 'explicit' head. Owner rule: Qwen does FB/ads/marketing work
    // ITSELF — full growth+content toolset, self-serve prompt, no marketer
    // sub-agent. With tier:'explicit' it got the slim toolset instead, truthfully
    // said "ads tool nai" and delegated marketing to the DeepSeek specialist.
    if (requested === marketingHeadModelId()) {
      return { modelId: requested, tier: 'marketing', via: 'explicit_marketing' }
    }
    return { modelId: requested, tier: 'explicit', via: 'explicit' }
  }

  if (!cheapHeadEnabled()) return heavy('flag_off')
  if (opts.personalMode) return heavy('personal')
  if (opts.businessId === 'ALMA_TRADING') return heavy('trading')

  const text = (opts.lastUserText ?? '').trim()
  if (!text) return heavy('empty')
  if (HEAVY_DENY_RE.test(text)) return heavy('deny_kw')
  // Placing a real phone call to a person on the owner's behalf is high-stakes (trust /
  // reputation) and must never be triaged to a cheap head — the cheap head mistook it for
  // a "reminder". Force Sonnet so the outbound_phone_call flow is handled correctly.
  if (isOutboundCallIntent(text)) return heavy('call_intent')

  // Personal / emotional message — the owner sharing HIS OWN feelings, not a task.
  // Route to the heavy head in LISTEN mode (tier 'personal'): downstream withholds
  // business tools + work context so the head just listens instead of pivoting to
  // work (the 2026-07-14 "hotash lagche → agent ran generate_image/ads" incident).
  // Placed AFTER the money/destructive + call guards (those still win) and BEFORE
  // the marketing/routine/sticky fast-paths (so a short emotional follow-up can't
  // stick to the marketing head). Gated behind a cheap regex hint → confirming
  // classifier; fails toward normal work routing so a work message is never
  // misread as personal.
  if (personalEmpathyEnabled() && PERSONAL_EMOTION_RE.test(text)) {
    if (await classifyIsPersonalEmotional(text, opts.conversationId)) {
      return { modelId: heavyHeadModelId(kvDefaultHead), tier: 'personal', via: 'personal_emotional' }
    }
  }

  // Marketing/content work → Qwen answers DIRECTLY as head (no Sonnet→worker hop),
  // the same direct-responder pattern as the cheap head. FAST PATH: an obvious
  // marketing phrase (regex) skips the triage call entirely.
  if (MARKETING_RE.test(text)) {
    const mk = marketingHeadDecision('marketing_kw')
    if (mk) return mk
  }

  // Routine status lookups (today's sales, who is in the office, stock/order counts)
  // → cheap head DIRECTLY, no triage call. High-frequency + low-stakes.
  if (ROUTINE_RE.test(text)) {
    const cheap = cheapHeadDecision('routine_kw')
    if (cheap) return cheap
  }

  // Rule 1 — thread stickiness: a short / continuation follow-up stays on the
  // thread's current cheap (DeepSeek) or marketing (Qwen) head instead of being
  // triaged UP to Sonnet. Only inherits NON-Sonnet heads (a heavy/Sonnet thread is
  // left to re-triage normally). HEAVY_DENY_RE already forced Sonnet above, so this
  // can never keep a money/destructive turn cheap.
  if (text.length <= CONTINUATION_MAX_LEN || CONTINUATION_RE.test(text)) {
    const sticky = await loadStickyHeadModelId(opts.conversationId)
    if (sticky && isKnownModelId(sticky)) {
      const m = getModel(sticky)
      // headPickable check: never let a follow-up inherit a worker-only head
      // (e.g. a pre-cleanup conversation whose last turn ran Flash Lite).
      if (m.provider !== 'anthropic' && m.supportsTools && m.headPickable !== false) {
        const tier: HeadTier = sticky === marketingHeadModelId() ? 'marketing' : 'light'
        return { modelId: sticky, tier, via: 'sticky_followup' }
      }
    }
  }

  // Triage net: the classifier also catches marketing intent the regex missed
  // (any phrasing/language) → Qwen; routine → cheap head; everything else → Sonnet.
  const tier = await triageTier(text, opts.conversationId)
  if (tier === 'marketing') {
    const mk = marketingHeadDecision('marketing_triage')
    if (mk) return mk
    return heavy('marketing_unavailable')
  }
  if (tier !== 'light') return heavy('triage')

  const cheap = cheapHeadDecision('triage')
  return cheap ?? heavy('cheap_invalid')
}
