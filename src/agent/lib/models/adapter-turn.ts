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
  /** True only when the model produced a tool-free final response. */
  completed: boolean
  inputTokens: number
  outputTokens: number
  /** Cached-prompt tokens read this turn. Adapters report inputTokens as
   *  uncached-only, so dropping these made sub-agent cost math miss the cached
   *  share entirely — callers must pass them to calcModelTurnCostUsd. */
  cacheRead: number
  cacheWrite: number
  /** Provider-billed ACTUAL cost (USD) summed across every turn of the tool loop,
   *  when the adapter reports it (OpenRouter). null when no turn reported a cost —
   *  the caller then falls back to the local token×rate estimate. */
  actualCostUsd: number | null
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
  let actualCostUsd: number | null = null
  let finalText = ''
  let completed = false
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
        if (ev.costUsd != null) actualCostUsd = (actualCostUsd ?? 0) + ev.costUsd
      }
    }

    if (iterationText.trim()) finalText = iterationText.trim()
    if (calls.length === 0 || args.signal?.aborted) {
      completed = calls.length === 0 && Boolean(iterationText.trim()) && !args.signal?.aborted
      break
    }

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

  // A model may use tools on the final allowed iteration. Returning the text it
  // wrote BEFORE those calls ("let me start...") as a successful summary is a
  // false-completion bug. Force one tool-free wrap-up from the actual results.
  if (!completed && !args.signal?.aborted) {
    const wrapupMessages: NeutralMsg[] = [
      ...messages,
      {
        role: 'user',
        content:
          '[INTERNAL CONTROL] Tool budget is exhausted. Do not call tools, promise future work, or claim an action that did not complete. ' +
          'Return a concise final status based only on the tool results above; clearly state anything still incomplete.',
      },
    ]
    let wrapupText = ''
    for await (const ev of adapter.streamTurn({
      apiModel: args.model.apiModel,
      system: args.system,
      messages: wrapupMessages,
      tools: [],
      thinking: args.model.thinking,
      signal: args.signal,
    })) {
      if (ev.type === 'text_delta') wrapupText += ev.text
      else if (ev.type === 'usage') {
        inputTokens += ev.inputTokens
        outputTokens += ev.outputTokens
        cacheRead += ev.cacheRead ?? 0
        cacheWrite += ev.cacheWrite ?? 0
        if (ev.costUsd != null) actualCostUsd = (actualCostUsd ?? 0) + ev.costUsd
      }
    }
    if (wrapupText.trim()) {
      finalText = wrapupText.trim()
      completed = true
    }
  }

  return {
    text: finalText,
    completed,
    inputTokens,
    outputTokens,
    cacheRead,
    cacheWrite,
    actualCostUsd,
    toolsUsed: Array.from(new Set(toolsUsed)),
  }
}
