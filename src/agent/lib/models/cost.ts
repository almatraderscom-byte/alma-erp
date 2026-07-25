import type { ModelEntry } from '@/agent/lib/models/registry'
import { roundUsd } from '@/agent/lib/pricing'

// Anthropic prompt-cache multipliers (relative to the model's own input rate):
// a cache WRITE costs 1.25× input, a cache READ costs 0.1× input. This holds across
// the whole Claude line (Sonnet 3→3.75/0.3, Opus 15→18.75/1.5, Haiku 1→1.25/0.1),
// so we derive cache rates from each model's inPerM instead of hard-coding Sonnet's.
const ANTHROPIC_CACHE_WRITE_MULT = 1.25
const ANTHROPIC_CACHE_READ_MULT = 0.1

/**
 * Non-Anthropic cache-READ discount, per model (relative to its own input rate).
 * Providers bill cached input very differently — a flat 0.25x mispriced DeepSeek
 * (real ~0.1x) and OpenAI (real ~0.5x) turns:
 *   - DeepSeek: cached input ~0.1x ($0.009 vs $0.09 per Mtok on V4 Flash)
 *   - Qwen (Alibaba): ~0.25x
 *   - Google Gemini implicit cache: ~0.25x
 *   - OpenAI: cached prompt tokens billed at 0.5x input
 * Matched on the apiModel slug first (OpenRouter routes many vendors), then provider.
 */
/**
 * Price of ONE cached input token for this model, per Mtok — the single source of
 * truth for both billing (below) and the cache-savings monitor (cost-dashboard).
 * Prefers the provider's PUBLISHED rate (`cachedInPerM`); falls back to the
 * per-vendor multiplier estimate when the provider doesn't publish one.
 */
export function cacheReadRatePerM(model: ModelEntry): number {
  if (typeof model.cachedInPerM === 'number') return model.cachedInPerM
  if (model.provider === 'anthropic') return model.inPerM * ANTHROPIC_CACHE_READ_MULT
  return model.inPerM * nonAnthropicCacheReadMult(model)
}

function nonAnthropicCacheReadMult(model: ModelEntry): number {
  const slug = model.apiModel.toLowerCase()
  if (slug.includes('deepseek')) return 0.1
  if (slug.includes('qwen')) return 0.25
  if (model.provider === 'google') return 0.25
  if (model.provider === 'openai') return 0.5
  return 0.25
}

/**
 * Per-turn cost for ANY head/worker model, billed at that model's OWN registry rate.
 *
 * Bug this fixes: every Anthropic model used to be funnelled through Sonnet's fixed
 * $3/$15 rate, so Opus ($15/$75) and Haiku ($1/$5) turns were mis-costed — the cost
 * page could not show what each model actually cost. Now input/output use
 * model.inPerM / model.outPerM, and Anthropic cache tokens are priced off the model's
 * own input rate.
 */
export function calcModelTurnCostUsd(
  model: ModelEntry,
  usage: {
    inputTokens: number
    outputTokens: number
    cacheRead?: number
    cacheWrite?: number
    /**
     * Reasoning/thinking tokens the provider bills as generation but reports
     * SEPARATELY from completion_tokens (cost audit Phase 7). xAI/Grok is the
     * confirmed case: a live turn showed reasoning 2023 vs visible output 383 —
     * reasoning > completion is only possible if it's not folded in, so we were
     * under-billing output by ~1500 tok/turn (~$3.5/mo, the xai −24% gap).
     * Billed at the model's OUTPUT rate. Callers pass this ONLY for providers
     * where reasoning is confirmed separate (never for OpenAI-style models whose
     * completion_tokens already INCLUDE reasoning — that would double-count).
     */
    reasoningTokens?: number
  },
): number {
  const input = (usage.inputTokens / 1_000_000) * model.inPerM
  const output = ((usage.outputTokens + (usage.reasoningTokens ?? 0)) / 1_000_000) * model.outPerM

  let cache = 0
  if (model.provider === 'anthropic') {
    const cacheWrite = ((usage.cacheWrite ?? 0) / 1_000_000) * model.inPerM * ANTHROPIC_CACHE_WRITE_MULT
    const cacheRead = ((usage.cacheRead ?? 0) / 1_000_000) * model.inPerM * ANTHROPIC_CACHE_READ_MULT
    cache = cacheWrite + cacheRead
  } else {
    // OpenRouter/OpenAI bill cached reads inside prompt_tokens at the full input
    // rate. The adapter now surfaces inputTokens as uncached-only (to stop the UI
    // double-count), so re-add the cached tokens here at the input rate to keep
    // the billed cost unchanged.
    // OpenRouter providers bill cached input at a steep discount (DeepSeek ~0.1x,
    // Alibaba/Qwen ~0.25x). We were re-adding cache reads at FULL input price,
    // inflating the displayed per-turn cost ~3-4x vs what OpenRouter actually
    // charges (the owner saw "$0.17" turns that really cost ~$0.05).
    // Phase 8: prefer the provider's PUBLISHED cached rate when the registry has
    // one (xAI grok-4.20 = $0.20/Mtok); otherwise keep the multiplier estimate.
    cache = ((usage.cacheRead ?? 0) / 1_000_000) * cacheReadRatePerM(model)
  }

  return roundUsd(input + output + cache)
}
