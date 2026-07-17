/**
 * P9 (behaviour-parity) — the ONE shared sampling/output contract, resolved
 * provider-neutrally and applied identically by every adapter.
 *
 * Why: today no adapter sets temperature/top_p/max_tokens on the owner-facing
 * turn, so every head runs at its provider's accidental default (Claude ~1.0,
 * Grok/DeepSeek via their host, Gemini ~1.0) and long replies truncate at
 * different lengths. That makes "the same behaviour on any model" impossible.
 *
 * Safety: when AGENT_UNIFORM_SAMPLING is off this returns `{}` so every adapter
 * keeps its EXACT current behaviour. temperature/top_p are applied ONLY when the
 * model is not reasoning — Anthropic REQUIRES temperature=1 with extended
 * thinking, and several reasoning providers likewise reject a custom sampler —
 * so with thinking on we still unify max_tokens (kills truncation divergence)
 * but leave the sampler at the provider default.
 */
import { AGENT_UNIFORM_SAMPLING, GENERATION_DEFAULTS } from '@/agent/config'

export type NeutralGenerationParams = {
  temperature?: number
  topP?: number
  maxTokens?: number
}

export function resolveGenerationParams(opts: { thinking?: string | undefined }): NeutralGenerationParams {
  if (!AGENT_UNIFORM_SAMPLING) return {}
  const params: NeutralGenerationParams = { maxTokens: GENERATION_DEFAULTS.maxTokens }
  const reasoning = Boolean(opts.thinking) && opts.thinking !== 'none'
  if (!reasoning) {
    params.temperature = GENERATION_DEFAULTS.temperature
    params.topP = GENERATION_DEFAULTS.topP
  }
  return params
}

/** Map the neutral params onto OpenAI/OpenRouter/xAI wire field names. */
export function toOpenAiGenerationParams(p: NeutralGenerationParams): Record<string, number> {
  const out: Record<string, number> = {}
  if (p.maxTokens !== undefined) out.max_tokens = p.maxTokens
  if (p.temperature !== undefined) out.temperature = p.temperature
  if (p.topP !== undefined) out.top_p = p.topP
  return out
}
