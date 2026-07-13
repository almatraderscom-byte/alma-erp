export interface NeutralTool {
  name: string
  description: string
  schema: object
}

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
  }): AsyncGenerator<TurnEvent>
}
