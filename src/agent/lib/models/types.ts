export interface NeutralTool {
  name: string
  description: string
  schema: object
}

export type NeutralMsg =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'assistant'; toolCalls: { id: string; name: string; input: Record<string, unknown> }[] }
  | { role: 'tool'; toolCallId: string; name: string; result: unknown }

export type TurnEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_input'; id: string; input: Record<string, unknown> }
  | {
      type: 'usage'
      inputTokens: number
      outputTokens: number
      cacheRead?: number
      cacheWrite?: number
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
