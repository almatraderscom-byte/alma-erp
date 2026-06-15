import type { Provider } from '@/agent/lib/models/registry'
import type { ProviderAdapter } from '@/agent/lib/models/types'
import { createGoogleAdapter } from '@/agent/lib/models/adapters/google'
import { createOpenAiAdapter } from '@/agent/lib/models/adapters/openai'

export function adapterFor(provider: Provider): ProviderAdapter {
  switch (provider) {
    case 'google':
      return createGoogleAdapter()
    case 'openai':
      return createOpenAiAdapter()
    default:
      throw new Error(`No adapter for provider: ${provider}`)
  }
}
