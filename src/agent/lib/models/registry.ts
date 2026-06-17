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
    inPerM: 15,
    outPerM: 75,
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
