import type { Provider } from '@/agent/lib/models/registry'
import type { ProviderAdapter } from '@/agent/lib/models/types'
import { createGoogleAdapter } from '@/agent/lib/models/adapters/google'
import { createOpenAiAdapter, createXaiAdapter } from '@/agent/lib/models/adapters/openai'
import { createOpenRouterAdapter } from '@/agent/lib/models/adapters/openrouter'
import { createAnthropicAdapter } from '@/agent/lib/models/adapters/anthropic'
import { costGatePreAuth, costGateMessage } from '@/agent/lib/models/cost-gate'

/**
 * Cost Governor seam (audit P0-2): EVERY provider chat call is pre-authorized
 * before network execution. A blocked call yields a Bangla text turn (owner
 * sees WHY) and never reaches a provider — crucially it also cannot trigger a
 * provider fallback, so a budget stop can't silently reroute to another paid
 * model.
 */
function withCostGate(inner: ProviderAdapter): ProviderAdapter {
  return {
    async *streamTurn(args) {
      const gate = await costGatePreAuth()
      if (!gate.allow) {
        yield { type: 'text_delta', text: costGateMessage(gate) }
        yield { type: 'done' }
        return
      }
      yield* inner.streamTurn(args)
    },
  }
}

export function adapterFor(provider: Provider): ProviderAdapter {
  return withCostGate(rawAdapterFor(provider))
}

function rawAdapterFor(provider: Provider): ProviderAdapter {
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
