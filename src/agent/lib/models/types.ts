import type { EffortDialect, EffortLevel } from '@/agent/lib/models/effort'

export interface NeutralTool {
  name: string
  description: string
  schema: object
}

/**
 * Provider-neutral tool_choice (Phase 3 request controller):
 * 'auto' = model decides (provider default), 'none' = no tool may be called,
 * 'required' = model MUST call some tool, { name } = model MUST call that tool.
 * Adapters map it to their provider dialect (OpenAI `tool_choice`, Gemini
 * `functionCallingConfig.mode`).
 */
export type NeutralToolChoice = 'auto' | 'none' | 'required' | { name: string }

export type NeutralMsg =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'assistant'; toolCalls: { id: string; name: string; input: Record<string, unknown>; thoughtSignature?: string }[] }
  | { role: 'tool'; toolCallId: string; name: string; result: unknown }

export type TurnEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_input'; id: string; input: Record<string, unknown>; thoughtSignature?: string }
  | {
      type: 'usage'
      inputTokens: number
      outputTokens: number
      cacheRead?: number
      cacheWrite?: number
      /**
       * Reasoning/thinking tokens the provider reports separately
       * (completion_tokens_details.reasoning_tokens on OpenAI-compatible reasoning
       * models). Cost audit Phase 7: observability only for now — recorded in the
       * cost event so we can see whether xAI/Grok bills reasoning tokens ON TOP of
       * completion_tokens (the suspected source of the ~24% xai under-estimate) or
       * folds them in. Billing is unchanged until the data confirms.
       */
      reasoningTokens?: number
      /**
       * Provider-billed ACTUAL cost for this turn, in USD. OpenRouter returns it
       * in `usage.cost` when the request opts in (`usage: { include: true }`).
       * When present it is authoritative — callers use it instead of the local
       * token×rate estimate (calcModelTurnCostUsd), so the displayed per-message
       * cost matches the OpenRouter dashboard exactly. Absent for providers that
       * don't report a cost (native Gemini/Anthropic), where the estimate stands.
       */
      costUsd?: number
    }
  | { type: 'done' }

export interface ProviderAdapter {
  streamTurn(args: {
    apiModel: string
    system: string
    messages: NeutralMsg[]
    tools: NeutralTool[]
    signal?: AbortSignal
    thinking?: 'adaptive' | 'level' | 'none'
    /**
     * Owner's thinking level for this turn, ALREADY clamped to what this model
     * supports (`clampEffort` in effort.ts). Absent = Auto: send no effort knob
     * and let the provider default stand — byte-identical to the pre-picker
     * request, which is what keeps every existing call site unchanged.
     */
    effort?: EffortLevel | null
    /** The dialect `effort` must be written in (registry `effort.dialect`). */
    effortDialect?: EffortDialect
    /**
     * Phase 3 request controller. Both are OPTIONAL — omitted means provider
     * default, so every existing call site behaves exactly as before.
     */
    toolChoice?: NeutralToolChoice
    /**
     * Allow the model to emit MORE THAN ONE tool call in a single round.
     * Phase 3 policy: true only for all-read packs; any pack containing a
     * stage/write capability gets false (multi-card / tool-spree class fix).
     */
    parallelToolCalls?: boolean
    /**
     * Stable per-conversation key for provider prompt-cache routing (cost audit
     * Phase 8). xAI stores cache entries per server and documents `x-grok-conv-id`
     * as the way to keep one conversation on the server holding its prefix.
     * Optional everywhere: adapters that don't do sticky routing ignore it, so no
     * existing call site changes behaviour.
     */
    cacheKey?: string
  }): AsyncGenerator<TurnEvent>
}
