import type { Provider } from '@/agent/lib/models/registry'
import type { ProviderAdapter } from '@/agent/lib/models/types'
import { createGoogleAdapter } from '@/agent/lib/models/adapters/google'
import { createOpenAiAdapter, createXaiAdapter } from '@/agent/lib/models/adapters/openai'
import { createOpenRouterAdapter } from '@/agent/lib/models/adapters/openrouter'
import { createAnthropicAdapter } from '@/agent/lib/models/adapters/anthropic'
import { costGatePreAuth, costGateMessage, type CostGateSurface } from '@/agent/lib/models/cost-gate'

/**
 * Cost Governor seam (audit P0-2): EVERY provider chat call is pre-authorized
 * before network execution. A blocked call yields a Bangla text turn (owner
 * sees WHY) and never reaches a provider — crucially it also cannot trigger a
 * provider fallback, so a budget stop can't silently reroute to another paid
 * model. The `surface` rides into the gate: 'cs' is exempt from BUDGET stops
 * (live customers are never silently cut off) but never from the kill switch.
 */
function withCostGate(inner: ProviderAdapter, surface: CostGateSurface): ProviderAdapter {
  return {
    async *streamTurn(args) {
      const gate = await costGatePreAuth(new Date(), surface)
      if (!gate.allow) {
        // Decision lineage (audit rule 9): every gate block is persisted, not
        // just streamed — fire-and-forget so the refusal itself never fails.
        void import('@/agent/lib/sentry')
          .then((m) => m.captureAgentError(
            new Error(`cost_gate_blocked:${gate.reason} surface=${surface} spent=$${gate.spentUsd ?? 0} cap=$${gate.capUsd ?? 0}`),
            'agent.cost_gate.block',
            { modelId: args.apiModel },
          ))
          .catch(() => {})
        yield { type: 'text_delta', text: costGateMessage(gate) }
        yield { type: 'done' }
        return
      }
      yield* inner.streamTurn(args)
    },
  }
}

export function adapterFor(provider: Provider, opts?: { surface?: CostGateSurface }): ProviderAdapter {
  return withCostGate(rawAdapterFor(provider), opts?.surface ?? 'other')
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
