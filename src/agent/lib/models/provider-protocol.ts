import {
  containsProviderToolProtocolSyntax,
  createMarkupStreamFilter,
} from '@/agent/lib/model-output-sanitize'
import {
  MODEL_REGISTRY,
  getModel,
  type ModelEntry,
  type Provider,
} from '@/agent/lib/models/registry'
import type { ProviderAdapter, TurnEvent } from '@/agent/lib/models/types'

export type ProviderApi =
  | 'messages'
  | 'generateContent'
  | 'responses'
  | 'chat.completions'
  | 'responses-or-chat.completions'

export type ProviderProtocolConformanceState = 'verified' | 'quarantined' | 'unknown'

export interface ProviderProtocolConformanceRow {
  modelId: string
  provider: Provider
  apiModel: string
  api: ProviderApi
  state: ProviderProtocolConformanceState
  checkedAt: string
  /** Recorded evidence only. Absence means unknown, never an inferred pass. */
  fixture?: string
  reason: string
}

const INCIDENT_FIXTURE =
  'src/agent/lib/models/__tests__/fixtures/provider-protocol-d00c.json#incident'

export function providerApi(
  provider: Provider,
  env: Record<string, string | undefined> = process.env,
): ProviderApi {
  switch (provider) {
    case 'anthropic': return 'messages'
    case 'google': return 'generateContent'
    // Keep this condition byte-for-byte aligned with openAiResponsesEnabled().
    // When enabled, request rejection can still descend to chat.completions, so
    // the composite label is the only truthful runtime telemetry binding.
    case 'openai': return env.OPENAI_RESPONSES_API === 'false'
      ? 'chat.completions'
      : 'responses-or-chat.completions'
    case 'openrouter':
    case 'xai':
      return 'chat.completions'
  }
}

/**
 * Provider/model/API conformance matrix.
 *
 * It is intentionally conservative: adapter unit coverage is not promoted to a
 * live-provider success claim. The exact d00c production response is the sole
 * quarantined binding; every other binding remains `unknown` until a recorded
 * provider fixture or production probe proves its content/tool channel.
 */
export const PROVIDER_PROTOCOL_CONFORMANCE: ProviderProtocolConformanceRow[] =
  MODEL_REGISTRY.flatMap<ProviderProtocolConformanceRow>((model): ProviderProtocolConformanceRow[] => {
    if (model.id === 'or-deepseek-v4-flash') {
      return [{
        modelId: model.id,
        provider: model.provider,
        apiModel: model.apiModel,
        api: 'chat.completions',
        state: 'quarantined',
        checkedAt: '2026-08-23',
        fixture: INCIDENT_FIXTURE,
        reason:
          'production d00c events 209-214 committed DSML in content with zero structured tool calls',
      }]
    }
    // Raw OpenAI genuinely has two runtime APIs (and Responses can fall back to
    // Chat Completions). Record both separately; neither is promoted to verified
    // by unit coverage alone.
    const apis: ProviderApi[] = model.provider === 'openai'
      ? ['responses', 'chat.completions']
      : [providerApi(model.provider)]
    return apis.map((api) => ({
      modelId: model.id,
      provider: model.provider,
      apiModel: model.apiModel,
      api,
      state: 'unknown',
      checkedAt: '2026-08-23',
      reason: 'no production content-vs-tool_calls fixture recorded by this incident audit',
    }))
  })

export function protocolConformanceFor(model: ModelEntry): ProviderProtocolConformanceRow {
  const rows = PROVIDER_PROTOCOL_CONFORMANCE.filter((row) => row.modelId === model.id)
  return rows.find((row) => row.state === 'quarantined') ?? rows[0] ?? {
    modelId: model.id,
    provider: model.provider,
    apiModel: model.apiModel,
    api: providerApi(model.provider),
    state: 'unknown',
    checkedAt: '2026-08-23',
    reason: 'model is absent from the recorded conformance matrix',
  }
}

export interface ProtocolFallbackDecision {
  from: ModelEntry
  to: ModelEntry
  evidence: ProviderProtocolConformanceRow
}

/** Marketing has its own execution tier even when the owner selected Qwen from
 * the picker; `via` is therefore part of the pin identity contract. */
export function isExplicitOwnerProtocolPin(input: { tier?: string; via: string }): boolean {
  return input.tier === 'explicit'
    || input.via === 'explicit'
    || input.via.startsWith('explicit_')
}

/**
 * A known-quarantined auto binding moves to an isolated provider account/API.
 * Unknown is not called "verified": the same canonical quarantine still wraps
 * the fallback, so another malformed content response fails closed too.
 * Explicit owner pins are never silently replaced.
 */
export function protocolSafeFallback(
  model: ModelEntry,
  opts: { explicitOwnerPin: boolean },
): ProtocolFallbackDecision | null {
  if (opts.explicitOwnerPin) return null
  const evidence = protocolConformanceFor(model)
  if (evidence.state !== 'quarantined') return null
  const fallback = getModel('gpt-5.6-luna')
  if (fallback.provider === model.provider) return null
  if (protocolConformanceFor(fallback).state === 'quarantined') return null
  return { from: model, to: fallback, evidence }
}

/** Runtime equivalent for a newly observed protocol violation. It does not
 * mutate the conformance matrix (that requires a reviewed recorded fixture),
 * but it chooses a non-quarantined model on a different provider. */
export function runtimeProtocolFallback(model: ModelEntry): ModelEntry | null {
  const candidates = ['gpt-5.6-luna', 'gemini-3.1-pro', 'claude-sonnet-4-6']
    .map((id) => getModel(id))
  return candidates.find((candidate) =>
    candidate.provider !== model.provider
    && candidate.supportsTools
    && candidate.headPickable !== false
    && protocolConformanceFor(candidate).state !== 'quarantined',
  ) ?? null
}

export class ProviderContentProtocolError extends Error {
  readonly code = 'PROVIDER_CONTENT_TOOL_PROTOCOL' as const
  readonly provider: Provider
  readonly api: ProviderApi
  readonly apiModel: string

  constructor(input: { provider: Provider; api: ProviderApi; apiModel: string }) {
    super(
      `Provider ${input.provider}/${input.apiModel} returned tool protocol in content without a structured tool call`,
    )
    this.name = 'ProviderContentProtocolError'
    this.provider = input.provider
    this.api = input.api
    this.apiModel = input.apiModel
  }
}

export function isProviderContentProtocolError(error: unknown): error is ProviderContentProtocolError {
  return error instanceof ProviderContentProtocolError
    || (error instanceof Error
      && (error as Partial<ProviderContentProtocolError>).code === 'PROVIDER_CONTENT_TOOL_PROTOCOL')
}

/**
 * Canonical incremental provider boundary.
 *
 * Only provider-native `tool_start`/`tool_input` events can reach execution.
 * Tool syntax arriving through `text_delta` is quarantined as opaque content;
 * it is never parsed, repaired, or promoted. A DSML-only response fails at the
 * boundary, while a mixed response keeps its genuine structured calls and clean
 * prose. The filter holds partial openers, so arbitrary chunk splits are safe.
 */
export function withProviderProtocolNormalizer(
  inner: ProviderAdapter,
  context: { provider: Provider; api: ProviderApi },
): ProviderAdapter {
  return {
    async *streamTurn(args): AsyncGenerator<TurnEvent> {
      const prose = createMarkupStreamFilter()
      let probe = ''
      let sawProviderToolSyntax = false
      let structuredToolInputs = 0

      const inspect = (text: string) => {
        probe = (probe + text).slice(-512)
        if (containsProviderToolProtocolSyntax(probe)) sawProviderToolSyntax = true
      }
      const settle = function* (): Generator<TurnEvent> {
        const tail = prose.flush()
        if (tail) yield { type: 'text_delta', text: tail }
        if (sawProviderToolSyntax && structuredToolInputs === 0) {
          throw new ProviderContentProtocolError({
            provider: context.provider,
            api: context.api,
            apiModel: args.apiModel,
          })
        }
      }

      for await (const event of inner.streamTurn(args)) {
        if (event.type === 'text_delta') {
          inspect(event.text)
          const safe = prose.push(event.text)
          if (safe) yield { ...event, text: safe }
          continue
        }
        if (event.type === 'tool_input') structuredToolInputs += 1
        if (event.type === 'done') {
          yield* settle()
          yield event
          return
        }
        yield event
      }
      // Defensive: adapters should emit done, but an abruptly exhausted iterable
      // still flushes/quarantines instead of releasing a held machine tail.
      yield* settle()
    },
  }
}
