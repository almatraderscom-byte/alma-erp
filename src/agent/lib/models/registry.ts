/**
 * Owner /agent chat model registry — single source of truth.
 * Verify apiModel strings against provider dashboards before trusting in production.
 */

export type Provider = 'anthropic' | 'google' | 'openai' | 'openrouter'

export interface ModelEntry {
  id: string
  label: string
  provider: Provider
  apiModel: string
  supportsTools: boolean
  supportsCaching: boolean
  contextWindow: number
  inPerM: number
  outPerM: number
  thinking?: 'adaptive' | 'level' | 'none'
  default?: boolean
}

export const DEFAULT_MODEL_ID = 'claude-sonnet-4-6'

/**
 * Sentinel stored on a conversation when the owner wants the per-turn router to
 * choose the head model (the "Auto" pill in the model selector). It is NOT a real
 * model — `isKnownModelId('auto')` stays false on purpose so it can never be sent to
 * a provider; only the head-router understands it (→ triage routing).
 */
export const AUTO_MODEL_ID = 'auto'

/** True for the "Auto" sentinel (owner let the router pick the head model). */
export function isAutoModelId(id?: string | null): boolean {
  return id === AUTO_MODEL_ID
}

/** Accepted as a conversation modelId: any real model, or the Auto sentinel. */
export function isSelectableModelId(id: string): boolean {
  return id === AUTO_MODEL_ID || isKnownModelId(id)
}

export const MODEL_REGISTRY: ModelEntry[] = [
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    apiModel: 'claude-sonnet-4-6',
    supportsTools: true,
    supportsCaching: true,
    contextWindow: 200_000,
    inPerM: 3,
    outPerM: 15,
    thinking: 'adaptive',
    default: true,
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    provider: 'anthropic',
    apiModel: 'claude-opus-4-8',
    supportsTools: true,
    supportsCaching: true,
    contextWindow: 200_000,
    // Corrected 2026-07: list price is $5/$25 (was written 3x high, which
    // inflated Opus escalation cost estimates and the opus-gate budget math).
    inPerM: 5,
    outPerM: 25,
    thinking: 'adaptive',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    provider: 'anthropic',
    apiModel: 'claude-haiku-4-5-20251001',
    supportsTools: true,
    supportsCaching: true,
    contextWindow: 200_000,
    inPerM: 1,
    outPerM: 5,
    thinking: 'adaptive',
  },
  {
    id: 'gemini-3.1-pro',
    label: 'Gemini 3.1 Pro',
    provider: 'google',
    apiModel: 'gemini-3.1-pro-preview',
    supportsTools: true,
    supportsCaching: false,
    contextWindow: 1_000_000,
    inPerM: 2,
    outPerM: 12,
    thinking: 'level',
  },
  {
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    provider: 'google',
    apiModel: 'gemini-3.5-flash',
    supportsTools: true,
    supportsCaching: false,
    contextWindow: 1_000_000,
    inPerM: 1.5,
    outPerM: 9,
    thinking: 'level',
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash-Lite',
    provider: 'google',
    apiModel: 'gemini-3.1-flash-lite',
    supportsTools: true,
    supportsCaching: false,
    contextWindow: 1_000_000,
    inPerM: 0.3,
    outPerM: 1.2,
    thinking: 'level',
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    provider: 'openai',
    apiModel: 'gpt-5.5',
    supportsTools: true,
    supportsCaching: false,
    contextWindow: 400_000,
    inPerM: 5,
    outPerM: 30,
    thinking: 'none',
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    provider: 'openai',
    apiModel: 'gpt-5.4',
    supportsTools: true,
    supportsCaching: false,
    contextWindow: 400_000,
    inPerM: 2.5,
    outPerM: 15,
    thinking: 'none',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 mini',
    provider: 'openai',
    apiModel: 'gpt-5.4-mini',
    supportsTools: true,
    supportsCaching: false,
    contextWindow: 400_000,
    inPerM: 0.75,
    outPerM: 4.5,
    thinking: 'none',
  },
  {
    id: 'or-glm-4-32b',
    label: 'GLM 4 32B (OpenRouter)',
    provider: 'openrouter',
    apiModel: 'z-ai/glm-4-32b',
    supportsTools: true,
    supportsCaching: false,
    contextWindow: 128_000,
    inPerM: 0.1,
    outPerM: 0.1,
    thinking: 'none',
  },
  {
    id: 'or-gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash Lite (OpenRouter)',
    provider: 'openrouter',
    apiModel: 'google/gemini-2.5-flash-lite',
    supportsTools: true,
    supportsCaching: false,
    contextWindow: 1_000_000,
    inPerM: 0.1,
    outPerM: 0.4,
    thinking: 'none',
  },
  // ── Project A cost-optimization workers (non-critical tiers only) ──────────
  // Slugs + pricing verified by owner against openrouter.ai. supportsCaching now has
  // runtime effect: the OpenRouter adapter sends a cache_control breakpoint on the
  // system-prompt prefix, so these models reuse it across turns (cheaper context).
  // Critical tiers (finance/staff/orders) never resolve to these.
  {
    id: 'or-qwen3-max',
    label: 'Qwen 3.7 Max (OpenRouter)',
    provider: 'openrouter',
    apiModel: 'qwen/qwen3.7-max',
    supportsTools: true,
    supportsCaching: true,
    contextWindow: 1_000_000,
    inPerM: 1.25,
    outPerM: 3.75,
    // 'level' asks OpenRouter for reasoning tokens so the owner sees the same
    // live step-by-step thinking stream as the Gemini head. Models/providers
    // that can't reason simply return none — the adapter degrades gracefully.
    thinking: 'level',
  },
  {
    id: 'or-deepseek-v4-flash',
    label: 'DeepSeek V4 Flash (OpenRouter)',
    provider: 'openrouter',
    apiModel: 'deepseek/deepseek-v4-flash',
    supportsTools: true,
    supportsCaching: true,
    contextWindow: 1_000_000,
    inPerM: 0.09,
    outPerM: 0.18,
    // Same live-thinking request as the Qwen head (see note above).
    thinking: 'level',
  },
]

export function getModel(id?: string | null): ModelEntry {
  const found = MODEL_REGISTRY.find((m) => m.id === id)
  if (found) return found
  return MODEL_REGISTRY.find((m) => m.default) ?? MODEL_REGISTRY[0]
}

export function isKnownModelId(id: string): boolean {
  return MODEL_REGISTRY.some((m) => m.id === id)
}

export function modelsByProvider(): Record<Provider, ModelEntry[]> {
  const out: Record<Provider, ModelEntry[]> = { anthropic: [], google: [], openai: [], openrouter: [] }
  for (const m of MODEL_REGISTRY) out[m.provider].push(m)
  return out
}

export function isAnthropicModel(id: string): boolean {
  const m = MODEL_REGISTRY.find((e) => e.id === id)
  return m?.provider === 'anthropic'
}
