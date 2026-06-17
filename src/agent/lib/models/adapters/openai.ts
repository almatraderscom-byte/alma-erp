import OpenAI from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions'
import type { NeutralMsg, NeutralTool, ProviderAdapter, TurnEvent } from '@/agent/lib/models/types'

function toOpenAiMessages(system: string, messages: NeutralMsg[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: 'system', content: system }]

  for (const msg of messages) {
    if ('content' in msg && typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content })
      continue
    }

    if ('toolCalls' in msg) {
      out.push({
        role: 'assistant',
        content: null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        })),
      })
      continue
    }

    if (msg.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: JSON.stringify(msg.result),
      })
    }
  }

  return out
}

function toOpenAiTools(tools: NeutralTool[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.schema as Record<string, unknown>,
    },
  }))
}

export class OpenAiAdapter implements ProviderAdapter {
  private client: OpenAI

  constructor(apiKey: string, opts?: { baseURL?: string; defaultHeaders?: Record<string, string> }) {
    this.client = new OpenAI({
      apiKey,
      baseURL: opts?.baseURL,
      defaultHeaders: opts?.defaultHeaders,
    })
  }

  async *streamTurn(args: {
    apiModel: string
    system: string
    messages: NeutralMsg[]
    tools: NeutralTool[]
    signal?: AbortSignal
    thinking?: 'adaptive' | 'level' | 'none'
  }): AsyncGenerator<TurnEvent> {
    const stream = await this.client.chat.completions.create({
      model: args.apiModel,
      messages: toOpenAiMessages(args.system, args.messages),
      tools: args.tools.length ? toOpenAiTools(args.tools) : undefined,
      stream: true,
      stream_options: { include_usage: true },
    })

    const toolBuffers = new Map<number, { id: string; name: string; args: string }>()

    for await (const chunk of stream) {
      if (args.signal?.aborted) break

      const choice = chunk.choices[0]
      const delta = choice?.delta

      if (delta?.content) {
        yield { type: 'text_delta', text: delta.content }
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          let buf = toolBuffers.get(idx)
          if (!buf) {
            buf = { id: tc.id ?? `openai_${idx}_${Date.now()}`, name: tc.function?.name ?? '', args: '' }
            toolBuffers.set(idx, buf)
            if (buf.name) yield { type: 'tool_start', id: buf.id, name: buf.name }
          }
          if (tc.id) buf.id = tc.id
          if (tc.function?.name) buf.name = tc.function.name
          if (tc.function?.arguments) buf.args += tc.function.arguments
        }
      }

      if (choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'stop') {
        for (const buf of toolBuffers.values()) {
          if (!buf.name) continue
          let parsed: Record<string, unknown> = {}
          try {
            parsed = JSON.parse(buf.args || '{}') as Record<string, unknown>
          } catch {
            parsed = { _raw: buf.args }
          }
          yield { type: 'tool_input', id: buf.id, input: parsed }
        }
        toolBuffers.clear()
      }

      if (chunk.usage) {
        yield {
          type: 'usage',
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        }
      }
    }

    yield { type: 'done' }
  }
}

export function createOpenAiAdapter(): OpenAiAdapter {
  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key) throw new Error('OPENAI_API_KEY not configured')
  return new OpenAiAdapter(key)
}
