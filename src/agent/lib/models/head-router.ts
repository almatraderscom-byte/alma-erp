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
import { DEFAULT_MODEL_ID, getModel, isKnownModelId } from '@/agent/lib/models/registry'
import { calcModelTurnCostUsd } from '@/agent/lib/models/cost'
import { logCost } from '@/agent/lib/cost-events'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'

export type HeadTier = 'light' | 'heavy' | 'explicit' | 'marketing'

export interface HeadDecision {
  modelId: string
  tier: HeadTier
  /** Why this head was chosen — surfaced in cost logs for tuning. */
  via: string
}

const cheapHeadEnabled = (): boolean => process.env.ENABLE_CHEAP_HEAD !== 'false'
const cheapHeadModelId = (): string => process.env.CHEAP_HEAD_MODEL_ID?.trim() || 'or-deepseek-v4-flash'
const triageModelId = (): string => process.env.CHEAP_HEAD_TRIAGE_MODEL_ID?.trim() || 'or-deepseek-v4-flash'

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
const MARKETING_RE =
  /(marketing|মার্কেটিং|caption|ক্যাপশন|ফেসবুক\s*পোস্ট|fb\s*post|facebook\s*post|social\s*post|পোস্ট\s*(লিখ|বানা|দাও|তৈরি|রেডি)|post\s*(লিখ|বানা|write|create|draft)|বিজ্ঞাপন|\bads?\b|বুস্ট|boost|campaign|ক্যাম্পেইন|promotion|প্রমোশন|প্রচার|creative|ক্রিয়েটিভ|copywrit|কপি\s*(লিখ|বানা))/i

/**
 * Irreversible / high-stakes signals that must ALWAYS get Sonnet — we don't even
 * spend a triage call on these. Bilingual (Bangla + Banglish + English).
 */
const HEAVY_DENY_RE =
  /(delete|remove|মুছে|বাদ\s*দাও|ডিলিট|payroll|salary|বেতন|বোনাস|bonus|ছাঁটাই|বরখাস্ত|terminate|fire\s|loan|ধার|ঋণ|investment|বিনিয়োগ|refund|ফেরত)/i

const TRIAGE_SYSTEM =
  'You are a routing classifier for a Bangla small-business assistant (small retail/office; owner is non-technical). ' +
  "Decide who answers the owner's latest message:\n" +
  '- "light": routine, low-stakes, mostly read/lookup or casual — greetings, thanks, acknowledgements, ' +
  'status questions (today\'s sales, who is present, stock/order/pending counts), simple info lookups, ' +
  'simple customer-service info, restating, simple reminders. A cheaper model handles these fine.\n' +
  '- "heavy": needs judgment or is sensitive — money decisions, finance write/edit/delete, payroll/salary/staff ' +
  'discipline, multi-step tasks, planning or strategy, marketing/ads substance, or anything ambiguous, unclear, ' +
  'or where a wrong answer costs money or trust.\n' +
  'When unsure, choose "heavy". Answer with EXACTLY one word: light or heavy.'

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
  const model = getModel(triageModelId())
  try {
    const resp = await client.chat.completions.create(
      {
        model: model.apiModel,
        max_tokens: 4,
        temperature: 0,
        messages: [
          { role: 'system', content: TRIAGE_SYSTEM },
          { role: 'user', content: text.slice(0, 1500) },
        ],
      },
      { signal: AbortSignal.timeout(8000) },
    )
    const usage = resp.usage
    if (usage) {
      const costUsd = calcModelTurnCostUsd(model, {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
      })
      void logCost({
        provider: 'openai',
        kind: 'chat',
        units: {
          input_tokens: usage.prompt_tokens ?? 0,
          output_tokens: usage.completion_tokens ?? 0,
          model: model.id,
          via: 'head-triage',
        },
        costUsd,
        conversationId: conversationId ?? null,
        dedupKey: `triage:${conversationId ?? 'na'}:${Date.now()}`,
      }).catch(() => {})
    }
    const out = (resp.choices[0]?.message?.content ?? '').toLowerCase()
    if (out.includes('light')) return 'light'
    return 'heavy'
  } catch (err) {
    console.warn('[head-router] triage failed → heavy:', err instanceof Error ? err.message : err)
    return 'heavy'
  }
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
  const heavy = (via: string): HeadDecision => ({ modelId: DEFAULT_MODEL_ID, tier: 'heavy', via })

  // Owner explicitly picked a non-default model for this conversation → honour it.
  const requested = opts.requestedModelId
  if (requested && requested !== DEFAULT_MODEL_ID && isKnownModelId(requested)) {
    return { modelId: requested, tier: 'explicit', via: 'explicit' }
  }

  if (!cheapHeadEnabled()) return heavy('flag_off')
  if (opts.personalMode) return heavy('personal')
  if (opts.businessId === 'ALMA_TRADING') return heavy('trading')

  const text = (opts.lastUserText ?? '').trim()
  if (!text) return heavy('empty')
  if (HEAVY_DENY_RE.test(text)) return heavy('deny_kw')

  // Marketing/content work → Qwen answers DIRECTLY as head (no Sonnet→worker hop).
  // Same direct-responder pattern as the cheap head, but for marketing turns. Falls
  // through to normal triage if the Qwen head is disabled/misconfigured/keyless.
  if (marketingHeadEnabled() && MARKETING_RE.test(text)) {
    const qId = marketingHeadModelId()
    if (isKnownModelId(qId) && process.env.OPENROUTER_API_KEY?.trim()) {
      const q = getModel(qId)
      if (q.provider !== 'anthropic' && q.supportsTools) {
        return { modelId: qId, tier: 'marketing', via: 'marketing' }
      }
    }
  }

  const tier = await triageTier(text, opts.conversationId)
  if (tier !== 'light') return heavy('triage')

  const cheapId = cheapHeadModelId()
  if (!isKnownModelId(cheapId)) return heavy('cheap_unknown')
  const cheap = getModel(cheapId)
  // The cheap head must be a non-Anthropic, tool-capable model (runs via the
  // adapter path). If misconfigured, fail safe to Sonnet.
  if (cheap.provider === 'anthropic' || !cheap.supportsTools) return heavy('cheap_invalid')

  return { modelId: cheapId, tier: 'light', via: 'triage' }
}
