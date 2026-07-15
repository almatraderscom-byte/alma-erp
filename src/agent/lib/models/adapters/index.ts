import type { Provider } from '@/agent/lib/models/registry'
import type { ProviderAdapter } from '@/agent/lib/models/types'
import { createGoogleAdapter } from '@/agent/lib/models/adapters/google'
import { createOpenAiAdapter, createXaiAdapter } from '@/agent/lib/models/adapters/openai'
import { createOpenRouterAdapter } from '@/agent/lib/models/adapters/openrouter'
import { createAnthropicAdapter } from '@/agent/lib/models/adapters/anthropic'

export function adapterFor(provider: Provider): ProviderAdapter {
  switch (provider) {
    case 'google':
      return createGoogleAdapter()
    case 'openai':
      return createOpenAiAdapter()
    case 'xai':
      return createXaiAdapter()
    case 'openrouter':
      return createOpenRouterAdapter()
    case 'anthropic':
      // Phase 6 — one turn engine: native Anthropic runs through the SAME
      // orchestrator as every other provider; only request shaping lives here.
      return createAnthropicAdapter()
    default:
      throw new Error(`No adapter for provider: ${provider}`)
  }
}
