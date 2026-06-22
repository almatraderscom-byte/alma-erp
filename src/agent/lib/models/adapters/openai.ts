import OpenAI from 'openai'
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions'
import type { NeutralMsg, NeutralTool, ProviderAdapter, TurnEvent } from '@/agent/lib/models/types'

function toOpenAiMessages(
  system: string,
  messages: NeutralMsg[],
  cachePrefix = false,
): ChatCompletionMessageParam[] {
  // Prompt caching (OpenRouter): the system prompt is the big, stable prefix
  // (business context, memories, instructions). Mark it with a cache_control
  // breakpoint so caching-capable models (DeepSeek, Qwen, Claude via OpenRouter)
  // reuse it across turns instead of re-billing it every message. cache_control is
  // an OpenRouter/Anthropic extension not in the OpenAI SDK types (hence the cast);
  // providers that don't support it ignore it safely.
  // ttl '1h' keeps the DeepSeek/Qwen prefix cached for at least an hour (default
  // is ~5 min) so back-to-back owner turns reuse it — cheaper for slow chats.
  const systemMsg: ChatCompletionMessageParam = cachePrefix
    ? ({
        role: 'system',
        content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      } as unknown as ChatCompletionMessageParam)
    : { role: 'system', content: system }
  const out: ChatCompletionMessageParam[] = [systemMsg]

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
  private cachePrefix: boolean
  private streamReasoning: boolean

  constructor(
    apiKey: string,
    opts?: {
      baseURL?: string
      defaultHeaders?: Record<string, string>
      cachePrefix?: boolean
      /**
       * Ask the provider to stream its reasoning/thinking tokens (OpenRouter
       * `reasoning`). Surfaced as `thinking_delta` so the UI shows a live
       * "Thought for Ns" block for DeepSeek/Qwen, just like Claude's extended
       * thinking. Owner can disable via STREAM_OPENROUTER_REASONING=false.
       */
      reasoning?: boolean
    },
  ) {
    this.client = new OpenAI({
      apiKey,
      baseURL: opts?.baseURL,
      defaultHeaders: opts?.defaultHeaders,
    })
    // Enable system-prompt caching breakpoints (OpenRouter). Owner can disable via
    // ENABLE_OPENROUTER_CACHE=false if a provider ever rejects the extension field.
    this.cachePrefix = (opts?.cachePrefix ?? false) && process.env.ENABLE_OPENROUTER_CACHE !== 'false'
    this.streamReasoning = (opts?.reasoning ?? false) && process.env.STREAM_OPENROUTER_REASONING !== 'false'
  }

  async *streamTurn(args: {
    apiModel: string
    system: string
    messages: NeutralMsg[]
    tools: NeutralTool[]
    signal?: AbortSignal
    thinking?: 'adaptive' | 'level' | 'none'
  }): AsyncGenerator<TurnEvent> {
    // `reasoning` is an OpenRouter extension (not in the OpenAI SDK types) that
    // asks reasoning-capable models (DeepSeek-reasoner, Qwen-thinking) to stream
    // their thinking tokens in `delta.reasoning`. Cast through unknown; providers
    // that don't support it ignore the field safely.
    const reasoningParam = this.streamReasoning ? { reasoning: { enabled: true } } : {}
    // Cast to the streaming params type so the `reasoning` extension is accepted
    // and the create() overload still resolves to a Stream (not a single reply).
    const stream = await this.client.chat.completions.create({
      model: args.apiModel,
      messages: toOpenAiMessages(args.system, args.messages, this.cachePrefix),
      tools: args.tools.length ? toOpenAiTools(args.tools) : undefined,
      stream: true,
      stream_options: { include_usage: true },
      ...reasoningParam,
    } as ChatCompletionCreateParamsStreaming)

    const toolBuffers = new Map<number, { id: string; name: string; args: string }>()

    for await (const chunk of stream) {
      if (args.signal?.aborted) break

      const choice = chunk.choices[0]
      const delta = choice?.delta

      // Reasoning/thinking tokens. OpenRouter streams them in `delta.reasoning`;
      // some upstream providers (DeepSeek native) use `reasoning_content`. Surface
      // either as a thinking_delta so the UI shows a live "Thought for Ns" block
      // for DeepSeek/Qwen, exactly like Claude's extended thinking.
      const reasoningDelta = delta as
        | { reasoning?: string | null; reasoning_content?: string | null }
        | undefined
      const reasoningText = reasoningDelta?.reasoning ?? reasoningDelta?.reasoning_content
      if (reasoningText) {
        yield { type: 'thinking_delta', text: reasoningText }
      }

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
        // OpenRouter/OpenAI report cache hits under prompt_tokens_details.cached_tokens.
        // Surface it as cacheRead so the turn loop can record cache effectiveness.
        // NB: OpenRouter's prompt_tokens INCLUDES the cached subset, whereas
        // Anthropic's input_tokens EXCLUDES cached. Subtract here so both providers
        // report uncached-only input and the UI total (in+out+cacheRead) doesn't
        // double-count the cached tokens.
        const cachedTokens =
          (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } })
            .prompt_tokens_details?.cached_tokens ?? 0
        const promptTokens = chunk.usage.prompt_tokens ?? 0
        yield {
          type: 'usage',
          inputTokens: Math.max(0, promptTokens - cachedTokens),
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheRead: cachedTokens,
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
