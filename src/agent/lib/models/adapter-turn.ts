/**
 * Non-streaming tool loop via ProviderAdapter (OpenRouter / OpenAI / Google).
 */
import type { ModelEntry } from '@/agent/lib/models/registry'
import type { NeutralMsg, NeutralTool } from '@/agent/lib/models/types'
import { adapterFor } from '@/agent/lib/models/adapters'
import { executeTool } from '@/agent/tools/registry'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'

export type AdapterTurnResult = {
  text: string
  inputTokens: number
  outputTokens: number
  /** Cached-prompt tokens read this turn. Adapters report inputTokens as
   *  uncached-only, so dropping these made sub-agent cost math miss the cached
   *  share entirely — callers must pass them to calcModelTurnCostUsd. */
  cacheRead: number
  cacheWrite: number
  toolsUsed: string[]
}

export async function runAdapterToolLoop(args: {
  model: ModelEntry
  system: string
  userTask: string
  tools: NeutralTool[]
  maxIterations?: number
  conversationId?: string
  businessId: AgentBusinessId
  signal?: AbortSignal
}): Promise<AdapterTurnResult> {
  const maxIterations = args.maxIterations ?? 4
  let messages: NeutralMsg[] = [{ role: 'user', content: args.userTask }]
  const toolsUsed: string[] = []
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let cacheWrite = 0
  let finalText = ''
  const adapter = adapterFor(args.model.provider)

  for (let i = 0; i < maxIterations; i++) {
    if (args.signal?.aborted) break

    const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
    const toolNames = new Map<string, string>()
    let iterationText = ''

    for await (const ev of adapter.streamTurn({
      apiModel: args.model.apiModel,
      system: args.system,
      messages,
      tools: args.tools,
      thinking: args.model.thinking,
      signal: args.signal,
    })) {
      if (ev.type === 'text_delta') iterationText += ev.text
      else if (ev.type === 'tool_start') toolNames.set(ev.id, ev.name)
      else if (ev.type === 'tool_input') {
        calls.push({ id: ev.id, name: toolNames.get(ev.id) ?? ev.id, input: ev.input })
      } else if (ev.type === 'usage') {
        inputTokens += ev.inputTokens
        outputTokens += ev.outputTokens
        cacheRead += ev.cacheRead ?? 0
        cacheWrite += ev.cacheWrite ?? 0
      }
    }

    if (iterationText.trim()) finalText = iterationText.trim()
    if (calls.length === 0 || args.signal?.aborted) break

    messages = [
      ...messages,
      { role: 'assistant', toolCalls: calls.map((c) => ({ id: c.id, name: c.name, input: c.input })) },
    ]

    for (const call of calls) {
      toolsUsed.push(call.name)
      const result = await executeTool(call.name, call.input, {
        conversationId: args.conversationId,
        businessId: args.businessId,
      })
      messages = [
        ...messages,
        { role: 'tool', toolCallId: call.id, name: call.name, result },
      ]
    }
  }

  return {
    text: finalText,
    inputTokens,
    outputTokens,
    cacheRead,
    cacheWrite,
    toolsUsed: Array.from(new Set(toolsUsed)),
  }
}
