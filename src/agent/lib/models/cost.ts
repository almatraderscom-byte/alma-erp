import type { ModelEntry } from '@/agent/lib/models/registry'
import { roundUsd } from '@/agent/lib/pricing'

// Anthropic prompt-cache multipliers (relative to the model's own input rate):
// a cache WRITE costs 1.25× input, a cache READ costs 0.1× input. This holds across
// the whole Claude line (Sonnet 3→3.75/0.3, Opus 15→18.75/1.5, Haiku 1→1.25/0.1),
// so we derive cache rates from each model's inPerM instead of hard-coding Sonnet's.
const ANTHROPIC_CACHE_WRITE_MULT = 1.25
const ANTHROPIC_CACHE_READ_MULT = 0.1

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
  },
): number {
  const input = (usage.inputTokens / 1_000_000) * model.inPerM
  const output = (usage.outputTokens / 1_000_000) * model.outPerM

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
    cache = ((usage.cacheRead ?? 0) / 1_000_000) * model.inPerM
  }

  return roundUsd(input + output + cache)
}
