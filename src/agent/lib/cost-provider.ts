import type { CostProvider } from '@/agent/lib/pricing'

/**
 * Provider recorded on a model invocation -> accounting provider.
 * Keep direct xAI usage separate from OpenAI even though its wire protocol is
 * OpenAI-compatible.
 */
export function modelProviderToCostProvider(provider: string): CostProvider {
  if (provider === 'google') return 'gemini'
  if (provider === 'openrouter') return 'openrouter'
  if (provider === 'openai') return 'openai'
  if (provider === 'xai') return 'xai'
  return 'anthropic'
}

/**
 * Historical rows can have a legacy stored provider while units.provider keeps
 * the real model provider. This mirrors EFFECTIVE_PROVIDER_SQL.
 */
export function effectiveCostProvider(unitsProvider: unknown, storedProvider: string): string {
  if (unitsProvider === 'openrouter') return 'openrouter'
  if (unitsProvider === 'google') return 'gemini'
  if (unitsProvider === 'openai') return 'openai'
  if (unitsProvider === 'xai') return 'xai'
  if (unitsProvider === 'anthropic') return 'anthropic'
  return storedProvider
}
