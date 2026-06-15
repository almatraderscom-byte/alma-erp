import type { ModelEntry } from '@/agent/lib/models/registry'
import { calcAnthropicChatCostUsd, roundUsd } from '@/agent/lib/pricing'

export function calcModelTurnCostUsd(
  model: ModelEntry,
  usage: {
    inputTokens: number
    outputTokens: number
    cacheRead?: number
    cacheWrite?: number
  },
): number {
  if (model.provider === 'anthropic') {
    return calcAnthropicChatCostUsd({
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_creation_input_tokens: usage.cacheWrite ?? 0,
      cache_read_input_tokens: usage.cacheRead ?? 0,
    })
  }

  const input = (usage.inputTokens / 1_000_000) * model.inPerM
  const output = (usage.outputTokens / 1_000_000) * model.outPerM
  return roundUsd(input + output)
}
