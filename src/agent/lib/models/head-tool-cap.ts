/**
 * P10 (behaviour-parity) — the head tool cap, extracted as a pure function so it
 * applies identically whether Grok reaches us via OpenRouter (`x-ai/grok-4.20`)
 * or xAI-direct (`grok-4.20`, provider 'xai'). Both hit xAI's 200-tool limit; the
 * old inline check only matched the OpenRouter slug, silently exposing the
 * xAI-direct head to the "Maximum tools limit reached" 400.
 */
import { AGENT_HEAD_PARITY } from '@/agent/config'

export function computeHeadToolCap(model: { apiModel: string; provider: string }): number {
  const isXai = model.apiModel.startsWith('x-ai/') || (AGENT_HEAD_PARITY && model.provider === 'xai')
  return isXai ? 200 : Infinity
}
