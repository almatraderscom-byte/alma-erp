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
  private includeCostUsage: boolean

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
      /**
       * Ask OpenRouter to attach the ACTUAL billed cost to the final usage chunk
       * (`usage: { include: true }` → `usage.cost` in USD). Only OpenRouter honours
       * this; raw OpenAI ignores/rejects the field, so it's opt-in per factory.
       * When on, the turn's displayed cost is OpenRouter's real charge instead of
       * a local token×rate estimate. Owner can disable via
       * OPENROUTER_INCLUDE_COST=false to fall back to the estimate.
       */
      includeCostUsage?: boolean
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
    this.includeCostUsage = (opts?.includeCostUsage ?? false) && process.env.OPENROUTER_INCLUDE_COST !== 'false'
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
    // asks reasoning-capable models (DeepSeek, Qwen-thinking) to stream their
    // thinking tokens in `delta.reasoning`. `{ enabled: true }` alone was too weak
    // for many providers — an explicit effort level is what reliably turns the
    // stream on, so the owner gets the same live step-by-step thinking as the
    // Gemini head. Gated on the model's registry `thinking` flag; if a
    // provider rejects the extension outright, retry once without it so the
    // head never goes down over a cosmetic feature.
    const wantReasoning = this.streamReasoning && args.thinking !== 'none'
    const reasoningParam = wantReasoning
      ? { reasoning: { enabled: true, effort: 'medium' } }
      : {}
    const baseParams = {
      model: args.apiModel,
      messages: toOpenAiMessages(args.system, args.messages, this.cachePrefix),
      tools: args.tools.length ? toOpenAiTools(args.tools) : undefined,
      stream: true as const,
      stream_options: { include_usage: true },
      // OpenRouter now ALWAYS returns the billed cost in the final chunk's
      // `usage.cost` (this opt-in flag is a documented no-op kept for intent +
      // forward-compat). Harmless to raw OpenAI. The actual gate on whether we
      // TRUST that cost is `this.includeCostUsage`, applied at read time below.
      ...(this.includeCostUsage ? { usage: { include: true } } : {}),
    }
    // Cast to the streaming params type so the `reasoning` extension is accepted
    // and the create() overload still resolves to a Stream (not a single reply).
    // The abort signal must reach the underlying fetch — checking it only
    // between chunks means a STALLED provider (no chunks at all) hangs past the
    // 280s turn abort until Vercel hard-kills the function at 300s: no salvage,
    // a forever-'running' turn row and a blank reply (2026-07-12 carousel run).
    const reqOptions = args.signal ? { signal: args.signal } : undefined
    // Pull OpenRouter's upstream detail out of an APIError — `error.metadata.raw`
    // carries the provider's real reason ("Provider returned error" alone is
    // useless; the 2026-07-13 Grok-4.20 outage was undiagnosable without it).
    const errDetail = (err: unknown): string => {
      const base = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (err as any)?.error
      const raw = body?.metadata?.raw ?? body?.error?.metadata?.raw
      return raw ? `${base} | provider: ${String(raw).slice(0, 300)}` : base
    }
    // Retry ladder: full request → without the reasoning extension → BARE
    // (no reasoning, no cache_control, no stream_options). A provider that 400s
    // on ANY optional extension must degrade the head to plain OpenAI-spec, never
    // knock it over to the fallback model (Grok-4.20 was silently DeepSeek all
    // day, 2026-07-13, because both extension-bearing attempts 400'd).
    let stream
    try {
      stream = await this.client.chat.completions.create({
        ...baseParams,
        ...reasoningParam,
      } as ChatCompletionCreateParamsStreaming, reqOptions)
    } catch (err) {
      if (args.signal?.aborted) throw err
      console.warn(
        `[openai-adapter] ${args.apiModel} rejected the full request — retrying without reasoning:`,
        errDetail(err),
      )
      try {
        stream = await this.client.chat.completions.create(
          baseParams as ChatCompletionCreateParamsStreaming,
          reqOptions,
        )
      } catch (err2) {
        if (args.signal?.aborted) throw err2
        console.warn(
          `[openai-adapter] ${args.apiModel} rejected the standard request too — final bare retry (no cache_control/stream_options):`,
          errDetail(err2),
        )
        const bareParams = {
          model: args.apiModel,
          messages: toOpenAiMessages(args.system, args.messages, false),
          tools: args.tools.length ? toOpenAiTools(args.tools) : undefined,
          stream: true as const,
        }
        stream = await this.client.chat.completions.create(
          bareParams as ChatCompletionCreateParamsStreaming,
          reqOptions,
        )
      }
    }

    const toolBuffers = new Map<number, { id: string; name: string; args: string; started: boolean }>()

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
            buf = { id: tc.id ?? `openai_${idx}_${Date.now()}`, name: tc.function?.name ?? '', args: '', started: false }
            toolBuffers.set(idx, buf)
          }
          if (tc.id) buf.id = tc.id
          if (tc.function?.name) buf.name = tc.function.name
          if (tc.function?.arguments) buf.args += tc.function.arguments
          // Some providers stream the function NAME in a later delta than the
          // first (index-only) chunk — emit tool_start whenever the name first
          // becomes known, not only at buffer creation, so the live step
          // timeline gets a properly-labelled chip.
          if (!buf.started && buf.name) {
            buf.started = true
            yield { type: 'tool_start', id: buf.id, name: buf.name }
          }
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
        // OpenRouter attaches the ACTUAL billed cost (USD; credits == USD on this
        // non-BYOK account, so it matches the dashboard) in `usage.cost` on the
        // final chunk. This is authoritative — it already reflects the provider's
        // real per-token + cache-discount rates,
        // so the caller uses it verbatim instead of estimating from the registry
        // table. Guard against 0/NaN so a provider that omits it falls back to the
        // local estimate rather than persisting a bogus $0.00.
        const rawCost = this.includeCostUsage ? (chunk.usage as { cost?: number }).cost : undefined
        const costUsd = typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost > 0
          ? rawCost
          : undefined
        yield {
          type: 'usage',
          inputTokens: Math.max(0, promptTokens - cachedTokens),
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheRead: cachedTokens,
          costUsd,
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
