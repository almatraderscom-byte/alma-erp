import OpenAI from 'openai'
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions'
import type { NeutralMsg, NeutralTool, NeutralToolChoice, ProviderAdapter, TurnEvent } from '@/agent/lib/models/types'
import { resolveGenerationParams, resolveToolSelectionSampler, toOpenAiGenerationParams } from '@/agent/lib/models/generation-params'
import type { EffortDialect, EffortLevel } from '@/agent/lib/models/effort'
import { repairToolArgs } from '@/agent/lib/models/tool-arg-repair'
import { AGENT_UNIFORM_SAMPLING, openAiSchemaSanitizeEnabled } from '@/agent/config'
import { sanitizeSchemaPortable } from '@/agent/lib/models/adapters/portable-schema'

/** P9 — honest marker appended when a reply is cut at max_tokens (finish_reason
 * 'length'), so the owner never sees a silent mid-sentence stop. */
const TRUNCATION_NOTE = '\n\n…(উত্তরটি দৈর্ঘ্যসীমায় কেটে গেছে — বাকিটা পেতে "continue" লিখুন)'

/**
 * Phase 3 request shaping (pure, unit-tested): map the neutral tool_choice /
 * parallel_tool_calls controls to OpenAI-dialect params. Only emitted when the
 * request actually carries tools — a tool_choice with no tools 400s on several
 * OpenRouter providers. Omitted fields keep the provider default, so callers
 * that don't pass the controls get the exact pre-Phase-3 request.
 */
export function buildOpenAiRequestShaping(args: {
  tools: NeutralTool[]
  toolChoice?: NeutralToolChoice
  parallelToolCalls?: boolean
}): { tool_choice?: unknown; parallel_tool_calls?: boolean } {
  if (args.tools.length === 0) return {}
  const out: { tool_choice?: unknown; parallel_tool_calls?: boolean } = {}
  if (args.toolChoice !== undefined && args.toolChoice !== 'auto') {
    out.tool_choice =
      typeof args.toolChoice === 'object'
        ? { type: 'function', function: { name: args.toolChoice.name } }
        : args.toolChoice // 'none' | 'required'
  }
  if (args.parallelToolCalls !== undefined) {
    out.parallel_tool_calls = args.parallelToolCalls
  }
  return out
}

/**
 * The final compatibility retry may drop optional provider shaping, but it
 * must never weaken a controller-enforced tool choice. Named/required choices
 * keep plan and workflow ordering deterministic; `none` is a hard safety
 * choice too. Automatic selection remains omitted as the provider default.
 */
export function buildOpenAiFallbackToolChoice(args: {
  tools: NeutralTool[]
  toolChoice?: NeutralToolChoice
}): { tool_choice?: unknown } {
  const { tool_choice } = buildOpenAiRequestShaping(args)
  return tool_choice === undefined ? {} : { tool_choice }
}

/**
 * Grok (x-ai/*) caches automatically on stable prefixes; the Anthropic-style
 * `cache_control` block is ignored there and only muddies the request (audit
 * correction #4). Keep it for the models that DO honour it via OpenRouter
 * (Claude, DeepSeek, Qwen).
 */
export function wantsAnthropicCacheControl(apiModel: string): boolean {
  return !apiModel.startsWith('x-ai/')
}

/**
 * OpenRouter Exacto routing (pure, unit-testable): append `:exacto` to the model
 * slug so OpenRouter picks providers by TOOL-CALL QUALITY instead of the default
 * price+speed "Balanced" mode. OpenRouter's own telemetry measured ~8%→~1%
 * tool-call error on the same model just from this provider tiering — the single
 * biggest lever on the "cheap model mangles tool calls" incident class.
 * Only applied when the request actually carries tools (that is what Exacto
 * tiers on), and never when the slug already pins a variant (`:nitro`/`:floor`).
 */
export function exactoSlug(apiModel: string, hasTools: boolean): string {
  if (!hasTools) return apiModel
  if (apiModel.includes(':')) return apiModel
  return `${apiModel}:exacto`
}

/**
 * Raw-OpenAI dialect compatibility (pure, unit-tested) — GPT-5.6 Luna head,
 * 2026-07-31, both 400s observed live on the preview:
 *   - "Unsupported parameter: 'max_tokens' is not supported with this model.
 *      Use 'max_completion_tokens' instead."  → rename the field.
 *   - "Function tools with reasoning_effort are not supported for gpt-5.6-luna
 *      in /v1/chat/completions. ... set reasoning_effort to 'none'." → OpenAI's
 *      DEFAULT effort is not 'none', so a tool-bearing request must say it
 *      explicitly (this also means the bare retry needs it — the default, not
 *      one of our optional params, is what 400s).
 * Only the raw-OpenAI factory applies this; OpenRouter/xAI request bytes are
 * unchanged.
 */
export function toRawOpenAiCompatParams(
  genParams: Record<string, number>,
  hasTools: boolean,
  effort?: string | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...genParams }
  if (out.max_tokens !== undefined) {
    out.max_completion_tokens = out.max_tokens
    delete out.max_tokens
  }
  // Tools + reasoning cannot coexist on this endpoint, so a tool-bearing request
  // is still de-reasoned. A TOOL-FREE one can carry the owner's level, which is
  // the difference between the picker working and silently doing nothing when the
  // Responses API is off or rejected the request (Codex P2).
  if (hasTools) out.reasoning_effort = 'none'
  else if (effort) out.reasoning_effort = effort
  return out
}

// ── Responses API (raw OpenAI / Luna head) ───────────────────────────────────
// Owner ask 2026-08-16: Luna's thought pane is empty. Two hard reasons on
// chat/completions: (1) gpt-5.6 rejects function tools + reasoning there, so
// every tool-bearing head turn was forced to reasoning_effort 'none' — Luna
// literally did not reason; (2) even when reasoning, OpenAI never returns the
// chain-of-thought on that API. The Responses API fixes both: tools + reasoning
// coexist, and `reasoning.summary` streams a model-written summary of the
// thinking (`response.reasoning_summary_text.delta`) — which we surface as the
// same thinking_delta the Gemini/DeepSeek heads use. Kill switch:
// OPENAI_RESPONSES_API=false restores the legacy chat/completions path.

export function openAiResponsesEnabled(): boolean {
  return process.env.OPENAI_RESPONSES_API !== 'false'
}

/**
 * 429 handling (owner-visible 2026-08-16: "Rate limit reached … try again in
 * 4.5s" surfaced as a dead turn). The org's TPM tier is finite and one head
 * turn is ~150k tokens, so back-to-back turns trip it routinely — a bounded
 * wait-and-retry makes that invisible instead of an error card. Returns the
 * seconds to wait, capped, or null when the error is not a rate limit.
 * Cap 30s (owner capture 2026-08-16: the provider asked for 14.8s — a 12s cap
 * made both retries land INSIDE the throttle window and the turn still died;
 * the suggested wait must actually be honoured, and a ~150k-token turn is far
 * too expensive to burn on premature retries).
 */
export function rateLimitRetryDelaySeconds(err: unknown, capSeconds = 61): number | null {
  const status = (err as { status?: number })?.status
  const message = err instanceof Error ? err.message : String(err)
  if (status !== 429 && !/rate limit/i.test(message)) return null
  const m = message.match(/try again in ([0-9.]+)s/i)
  const suggested = m ? Number.parseFloat(m[1]) : NaN
  const headerRaw = (err as { headers?: { get?: (k: string) => string | null } })?.headers?.get?.('retry-after')
  const header = headerRaw ? Number.parseFloat(headerRaw) : NaN
  const wait = Number.isFinite(suggested) ? suggested : Number.isFinite(header) ? header : 5
  return Math.min(Math.max(wait + 0.5, 1), capSeconds)
}

/** Reasoning effort for Luna head turns. 'medium' by default: live probes
 *  2026-08-16 showed 'low' almost never yields a visible reasoning summary
 *  (thinks=0 across multi-round tool turns) while 'medium' streams a real one
 *  — and a visible thought pane is the entire point. Owner-tunable via env. */
export function lunaReasoningEffort(): 'minimal' | 'low' | 'medium' | 'high' {
  const v = process.env.LUNA_REASONING_EFFORT?.trim()
  return v === 'minimal' || v === 'low' || v === 'high' ? v : 'medium'
}

/** OpenAI reasoning items ride the neutral thoughtSignature lane as JSON. */
const REASONING_SIG_PREFIX = 'openai-responses:'
export function encodeReasoningSignature(id: string, encryptedContent: string): string {
  return REASONING_SIG_PREFIX + JSON.stringify({ id, encrypted_content: encryptedContent })
}
function parseReasoningSignature(
  sig: string | undefined,
): { id: string; encrypted_content: string } | null {
  // A Gemini thoughtSignature can legitimately appear in history after a
  // mid-conversation head switch — only OUR prefix is ours to replay.
  if (!sig || !sig.startsWith(REASONING_SIG_PREFIX)) return null
  try {
    const parsed = JSON.parse(sig.slice(REASONING_SIG_PREFIX.length)) as {
      id?: unknown
      encrypted_content?: unknown
    }
    return typeof parsed.id === 'string' && typeof parsed.encrypted_content === 'string'
      ? { id: parsed.id, encrypted_content: parsed.encrypted_content }
      : null
  } catch {
    return null
  }
}

/** Neutral history → Responses input items (function calls round-trip as
 *  function_call / function_call_output items instead of role messages). */
export function toResponsesInput(messages: NeutralMsg[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const msg of messages) {
    if ('content' in msg && typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content })
      continue
    }
    if ('toolCalls' in msg) {
      for (const tc of msg.toolCalls) {
        // Stateless reasoning continuation (Codex P1): with store:false the
        // reasoning item that PRECEDED this function call must be replayed
        // (encrypted) or multi-round tool use loses/rejects the model's
        // reasoning state. It rides the same thoughtSignature lane Gemini
        // already round-trips through the turn loop.
        const sig = parseReasoningSignature(tc.thoughtSignature)
        if (sig) {
          out.push({
            type: 'reasoning',
            id: sig.id,
            encrypted_content: sig.encrypted_content,
            summary: [],
          })
        }
        out.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.input),
        })
      }
      continue
    }
    if (msg.role === 'tool') {
      // Same image-stripping rule as the chat path: a vision result's base64
      // payload is undecodable garbage to a text tool output.
      let payload: unknown = msg.result
      if (payload && typeof payload === 'object' && 'image' in (payload as Record<string, unknown>)) {
        const { image: _omit, ...rest } = payload as Record<string, unknown>
        payload = rest
      }
      out.push({
        type: 'function_call_output',
        call_id: msg.toolCallId,
        output: JSON.stringify(payload),
      })
    }
  }
  return out
}

/** Responses tools are FLAT (no nested `function` object). */
export function toResponsesTools(tools: NeutralTool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    strict: false,
    parameters: openAiSchemaSanitizeEnabled()
      ? sanitizeSchemaPortable(t.schema)
      : (t.schema as Record<string, unknown>),
  }))
}

export function toResponsesToolChoice(choice?: NeutralToolChoice): unknown {
  if (choice === undefined || choice === 'auto') return undefined
  return typeof choice === 'object' ? { type: 'function', name: choice.name } : choice
}

/**
 * Map the Responses event stream to neutral TurnEvents. Exported for unit
 * tests (fed a fake async iterable). Tool arguments are taken WHOLE from the
 * output_item.done event — no delta re-assembly to get wrong.
 */
 
 
function mapResponsesUsage(usage: any): TurnEvent {
  const cached = usage.input_tokens_details?.cached_tokens ?? 0
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? 0
  return {
    type: 'usage',
    inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
    outputTokens: usage.output_tokens ?? 0,
    cacheRead: cached,
    reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
  }
}

export async function* mapResponsesStream(
   
  stream: AsyncIterable<any>,
  opts: { signal?: AbortSignal; truncationNote?: boolean } = {},
): AsyncGenerator<TurnEvent> {
  let pendingReasoningSig: string | null = null
  for await (const event of stream) {
    if (opts.signal?.aborted) break
    switch (event.type) {
      case 'response.reasoning_summary_text.delta':
        if (event.delta) yield { type: 'thinking_delta', text: String(event.delta) }
        break
      case 'response.output_text.delta':
        if (event.delta) yield { type: 'text_delta', text: String(event.delta) }
        break
      case 'response.output_item.added':
        if (event.item?.type === 'function_call' && event.item.name) {
          yield {
            type: 'tool_start',
            id: String(event.item.call_id ?? event.item.id ?? `resp_${Date.now()}`),
            name: String(event.item.name),
          }
        }
        break
      case 'response.output_item.done':
        // Reasoning item finishing BEFORE a function call: keep its encrypted
        // content so the next stateless round can replay it (Codex P1).
        if (event.item?.type === 'reasoning' && event.item.id
          && typeof event.item.encrypted_content === 'string' && event.item.encrypted_content) {
          pendingReasoningSig = encodeReasoningSignature(
            String(event.item.id), event.item.encrypted_content)
        }
        if (event.item?.type === 'function_call' && event.item.name) {
          const repair = repairToolArgs(String(event.item.arguments ?? ''))
          const parsed: Record<string, unknown> = repair.ok ? repair.value : { _raw: repair.raw }
          yield {
            type: 'tool_input',
            id: String(event.item.call_id ?? event.item.id ?? `resp_${Date.now()}`),
            input: parsed,
            // First call after a reasoning burst carries the replay signature —
            // toResponsesInput re-emits the reasoning item ahead of it.
            ...(pendingReasoningSig ? { thoughtSignature: pendingReasoningSig } : {}),
          }
          pendingReasoningSig = null
        }
        break
      case 'response.incomplete': {
        if (opts.truncationNote
          && event.response?.incomplete_details?.reason === 'max_output_tokens') {
          yield { type: 'text_delta', text: TRUNCATION_NOTE }
        }
        // A truncated round is still BILLED (Codex P2) — usage lives on this
        // terminal event exactly like response.completed.
        const usage = event.response?.usage
        if (usage) yield mapResponsesUsage(usage)
        break
      }
      case 'response.failed': {
        const message = event.response?.error?.message ?? 'response.failed'
        throw new Error(`[openai-responses] ${String(message)}`)
      }
      case 'error': {
        throw new Error(`[openai-responses] ${String(event.message ?? 'stream error')}`)
      }
      case 'response.completed': {
        const usage = event.response?.usage
        if (usage) yield mapResponsesUsage(usage)
        break
      }
      default:
        break
    }
  }
  yield { type: 'done' }
}

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
      // Chat-completions tool messages are TEXT-ONLY — a vision result's base64
      // `image` (now preserved by the neutral cap, Phase 6) would ship ~100KB of
      // undecodable garbage here. Strip it; the textual result keeps the
      // screenshotUrl, which is what these models can actually use.
      let payload: unknown = msg.result
      if (payload && typeof payload === 'object' && 'image' in (payload as Record<string, unknown>)) {
        const { image: _omit, ...rest } = payload as Record<string, unknown>
        payload = rest
      }
      out.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: JSON.stringify(payload),
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
      // Universal pipeline Phase 5 (Bug C): the Gemini path has always sanitised
      // its declarations; this one shipped raw registry schemas, so "the same
      // tool" was a different tool per provider. Light, non-lossy normalisation
      // (see portable-schema.ts) — constraints preserved, structural/vendor keys
      // dropped, deterministic key order for prefix-cache byte stability.
      parameters: openAiSchemaSanitizeEnabled()
        ? sanitizeSchemaPortable(t.schema)
        : (t.schema as Record<string, unknown>),
    },
  }))
}

export class OpenAiAdapter implements ProviderAdapter {
  private client: OpenAI
  private cachePrefix: boolean
  private streamReasoning: boolean
  private includeCostUsage: boolean
  private exacto: boolean
  private requireParameters: boolean
  private stickyCacheHeader: boolean
  private rawOpenAi: boolean

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
      /**
       * OpenRouter Exacto: route tool-bearing requests to the providers with the
       * best measured tool-call quality (see exactoSlug above). Owner kill switch:
       * ENABLE_OPENROUTER_EXACTO=false.
       */
      exacto?: boolean
      /**
       * OpenRouter `provider.require_parameters`: only route to hosts that support
       * EVERY parameter in the request (tools especially) instead of silently
       * dropping unsupported ones — a documented cause of "the model ignored my
       * tools" on third-party hosts. Owner kill switch:
       * OPENROUTER_REQUIRE_PARAMETERS=false.
       */
      requireParameters?: boolean
      /**
       * Raw-OpenAI dialect fixes (GPT-5.6 Luna head, 2026-07-31). OpenAI's
       * reasoning models 400 on the legacy `max_tokens` param ("use
       * 'max_completion_tokens' instead") and 400 on tool-bearing
       * chat/completions requests unless `reasoning_effort: 'none'` is sent
       * explicitly (their default effort is not 'none'). Both fixes are scoped
       * to the raw-OpenAI factory only — OpenRouter and xAI keep the exact
       * request bytes they had.
       */
      rawOpenAi?: boolean
      /**
       * xAI sticky cache routing (cost audit Phase 8). xAI stores prompt-cache
       * entries PER SERVER, and its docs recommend the `x-grok-conv-id` header to
       * maximise the hit rate — without it, consecutive turns of the same
       * conversation can land on different servers and re-pay full input price for
       * an identical prefix. Opt-in per factory so OpenAI/OpenRouter requests stay
       * byte-identical. Owner kill switch: XAI_STICKY_CACHE=false.
       */
      stickyCacheHeader?: boolean
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
    this.exacto = (opts?.exacto ?? false) && process.env.ENABLE_OPENROUTER_EXACTO !== 'false'
    this.requireParameters = (opts?.requireParameters ?? false) && process.env.OPENROUTER_REQUIRE_PARAMETERS !== 'false'
    this.stickyCacheHeader = (opts?.stickyCacheHeader ?? false) && process.env.XAI_STICKY_CACHE !== 'false'
    this.rawOpenAi = opts?.rawOpenAi ?? false
  }

  async *streamTurn(args: {
    apiModel: string
    system: string
    messages: NeutralMsg[]
    tools: NeutralTool[]
    signal?: AbortSignal
    thinking?: 'adaptive' | 'level' | 'none'
    effort?: EffortLevel | null
    effortDialect?: EffortDialect
    toolChoice?: NeutralToolChoice
    parallelToolCalls?: boolean
    cacheKey?: string
  }): AsyncGenerator<TurnEvent> {
    // Owner's thinking level. Both OpenAI-dialect knobs take the same words, so
    // one clamped level serves the raw-OpenAI Responses API and OpenRouter's
    // normalized `reasoning.effort` alike. A level resolved for a NON-OpenAI
    // dialect (Auto head switched provider mid-job) is ignored rather than
    // guessed at.
    const ownerEffort =
      args.effortDialect === 'openai_effort' || args.effortDialect === 'openrouter_effort'
        ? args.effort ?? null
        : null
    // Raw OpenAI (Luna head): prefer the Responses API — tools + reasoning
    // coexist there and the model's reasoning SUMMARY streams live, so the
    // owner finally sees Luna think (chat/completions forced tool-bearing
    // turns to reasoning_effort 'none' AND hides the chain-of-thought).
    // A create() failure falls through to the proven chat/completions ladder
    // below — the head never goes down over this path.
    if (this.rawOpenAi && openAiResponsesEnabled()) {
      // An explicit level IS a request to reason — gpt-5.5 is registered
      // `thinking: 'none'` (it was only ever about the streamed thought pane and
      // the sampler), yet its API documents low→xhigh effort. Without this the
      // owner could pick "High" on that head and nothing would be sent.
      const wantsReasoning = args.thinking !== 'none' || Boolean(ownerEffort)
      const rawGen = toOpenAiGenerationParams(resolveGenerationParams({ thinking: args.thinking }))
      const responsesParams: Record<string, unknown> = {
        model: args.apiModel,
        instructions: args.system,
        input: toResponsesInput(args.messages),
        stream: true,
        store: false,
        ...(args.tools.length ? { tools: toResponsesTools(args.tools) } : {}),
        ...(rawGen.max_tokens !== undefined ? { max_output_tokens: rawGen.max_tokens } : {}),
        ...(wantsReasoning
          // include reasoning.encrypted_content: with store:false the item
          // must come back encrypted or the next tool round cannot replay it.
          ? {
            reasoning: { effort: ownerEffort ?? lunaReasoningEffort(), summary: 'auto' },
            include: ['reasoning.encrypted_content'],
          }
          // Non-reasoning request: the sampler is accepted, mirror the shared contract.
          : {
            ...(rawGen.temperature !== undefined ? { temperature: rawGen.temperature } : {}),
            ...(rawGen.top_p !== undefined ? { top_p: rawGen.top_p } : {}),
          }),
      }
      const responsesChoice = args.tools.length ? toResponsesToolChoice(args.toolChoice) : undefined
      if (responsesChoice !== undefined) responsesParams.tool_choice = responsesChoice
      if (args.tools.length && args.parallelToolCalls !== undefined) {
        responsesParams.parallel_tool_calls = args.parallelToolCalls
      }
      let responsesStream: AsyncIterable<unknown> | null = null
      // Up to two bounded rate-limit waits before giving up on this API: the
      // org TPM tier trips on back-to-back head turns and asks for ~5s — an
      // error card for that is unacceptable when waiting fixes it.
      for (let attempt = 0; attempt < 3 && !responsesStream; attempt++) {
        try {
          responsesStream = await this.client.responses.create(
             
            responsesParams as any,
            // maxRetries 0 (Codex P2): the SDK's built-in 429 retries would
            // multiply with this loop (3×3 requests) — this loop is the single
            // retry mechanism, and it honors the provider's suggested delay.
            { maxRetries: 0, ...(args.signal ? { signal: args.signal } : {}) },
          ) as unknown as AsyncIterable<unknown>
        } catch (err) {
          if (args.signal?.aborted) throw err
          const retryDelay = attempt < 2 ? rateLimitRetryDelaySeconds(err) : null
          if (retryDelay != null) {
            console.warn(
              `[openai-adapter] ${args.apiModel} rate-limited — retrying in ${retryDelay}s (attempt ${attempt + 1})`,
            )
            // Abortable sleep (Codex P2): the owner cancelling the turn must
            // not sit behind a rate-limit wait.
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, retryDelay * 1000)
              args.signal?.addEventListener('abort', () => {
                clearTimeout(timer)
                resolve()
              }, { once: true })
            })
            if (args.signal?.aborted) throw err
            continue
          }
          console.warn(
            `[openai-adapter] ${args.apiModel} Responses API rejected the request — falling back to chat/completions:`,
            err instanceof Error ? err.message : String(err),
          )
          break
        }
      }
      if (responsesStream) {
        yield* mapResponsesStream(responsesStream, {
          signal: args.signal,
          truncationNote: AGENT_UNIFORM_SAMPLING,
        })
        return
      }
    }
    // `reasoning` is an OpenRouter extension (not in the OpenAI SDK types) that
    // asks reasoning-capable models (DeepSeek, Qwen-thinking) to stream their
    // thinking tokens in `delta.reasoning`. `{ enabled: true }` alone was too weak
    // for many providers — an explicit effort level is what reliably turns the
    // stream on, so the owner gets the same live step-by-step thinking as the
    // Gemini head. Gated on the model's registry `thinking` flag; if a
    // provider rejects the extension outright, retry once without it so the
    // head never goes down over a cosmetic feature.
    const wantReasoning = this.streamReasoning && (args.thinking !== 'none' || Boolean(ownerEffort))
    const reasoningParam = wantReasoning
      // 'medium' was a hard-coded default that ignored the model AND the owner.
      // OpenRouter accepts none|minimal|low|medium|high|xhigh|max and maps each
      // onto the host's own dialect (thinking budget %, Gemini thinkingLevel),
      // clamping anything the target cannot do — so the owner's word travels
      // unchanged and only the provider decides what it means.
      ? { reasoning: { enabled: true, effort: ownerEffort ?? 'medium' } }
      : {}
    // Grok caches prefixes automatically — skip the Anthropic-style cache_control
    // extension for x-ai/* models (Phase 3 cleanup; see wantsAnthropicCacheControl).
    const cachePrefix = this.cachePrefix && wantsAnthropicCacheControl(args.apiModel)
    // Exacto quality routing on tool-bearing requests (OpenRouter-only factory
    // option). The variant slug is understood by OpenRouter alone, so the raw
    // OpenAI/xAI factories never enable it.
    const modelSlug = this.exacto ? exactoSlug(args.apiModel, args.tools.length > 0) : args.apiModel
    // provider.require_parameters: filter to hosts that honour tools + our other
    // params. Scoped to tool-bearing requests (the failure class it fixes) and
    // dropped from the final BARE retry below like every other extension.
    const providerPrefs = this.requireParameters && args.tools.length > 0
      ? { provider: { require_parameters: true } }
      : {}
    // The registry's `thinking` flag describes the MODEL, not the request we are
    // about to send. On raw OpenAI a tool-bearing request is forced to
    // reasoning_effort 'none' below, so a model registered as 'level' (Luna)
    // actually runs NON-reasoning here. Resolving the sampler off the registry
    // label applied the "reasoning providers reject a custom sampler" exemption
    // to a request that is not a reasoning request — the head then chose tools at
    // the provider's default temperature. Resolve off the EFFECTIVE state.
    const reasoningSuppressed = this.rawOpenAi && args.tools.length > 0
    const effectiveThinking = reasoningSuppressed ? 'none' : args.thinking
    // P9 — shared sampling/output contract (temperature/top_p/max_tokens). When
    // AGENT_UNIFORM_SAMPLING is off this is {} → exact pre-parity request.
    const rawGenParams = toOpenAiGenerationParams(resolveGenerationParams({ thinking: effectiveThinking }))
    // Tool-selection sampler for the de-reasoned request. Carried as its own
    // optional param (NOT folded into genParams) so it rides only the first
    // attempt: a model that rejects `temperature` degrades on the standard retry
    // below with everything else intact, exactly like the other extensions.
    // It OVERRIDES the uniform-sampling temperature rather than deferring to it
    // (Codex P2). AGENT_UNIFORM_SAMPLING is auto-on in previews and supplies
    // GENERATION_DEFAULTS.temperature (0.7) once `effectiveThinking` is 'none' —
    // deferring meant the de-reasoned head kept picking tools at 0.7 on the very
    // environment this fix is verified in. Parity's job is to make providers
    // agree; this one exists to make tool choice repeatable, and it is the
    // narrower, later rule.
    const toolSampler = reasoningSuppressed ? resolveToolSelectionSampler() : null
    const samplerParam = toolSampler ? { temperature: toolSampler.temperature } : {}
    // Raw-OpenAI dialect: max_tokens → max_completion_tokens + explicit
    // reasoning_effort 'none' on tool-bearing requests (see toRawOpenAiCompatParams).
    const genParams = this.rawOpenAi
      ? toRawOpenAiCompatParams(rawGenParams, args.tools.length > 0, ownerEffort)
      : rawGenParams
    const baseParams = {
      model: modelSlug,
      ...genParams,
      messages: toOpenAiMessages(args.system, args.messages, cachePrefix),
      tools: args.tools.length ? toOpenAiTools(args.tools) : undefined,
      stream: true as const,
      stream_options: { include_usage: true },
      // Phase 3 request controller: per-call tool_choice + parallel_tool_calls.
      // The final bare retry drops optional parallel shaping but preserves hard
      // named/required/none choices so controller ordering cannot silently weaken.
      ...buildOpenAiRequestShaping(args),
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
    // Sticky prompt-cache routing (Phase 8). xAI keeps cache entries per server, so
    // the SAME conversation must land on the same one to reuse its prefix; the
    // header is what pins it. Sent per-request (not on the client) because the key
    // is per-conversation. Only set when the factory opted in and a key exists, so
    // every other provider's request bytes are unchanged.
    const stickyHeaders = this.stickyCacheHeader && args.cacheKey
      ? { 'x-grok-conv-id': args.cacheKey }
      : undefined
    // maxRetries 0 on every rung (Codex P1 on PR #783, same class as #780):
    // the SDK's built-in 429/5xx retries would multiply with the manual
    // rate-limit loop — the loop is the single retry mechanism.
    const reqOptions = {
      maxRetries: 0,
      ...(args.signal ? { signal: args.signal } : {}),
      ...(stickyHeaders ? { headers: stickyHeaders } : {}),
    }
    // Pull OpenRouter's upstream detail out of an APIError — `error.metadata.raw`
    // carries the provider's real reason ("Provider returned error" alone is
    // useless; the 2026-07-13 Grok-4.20 outage was undiagnosable without it).
    const errDetail = (err: unknown): string => {
      const base = err instanceof Error ? err.message : String(err)
       
      const body = (err as any)?.error
      const raw = body?.metadata?.raw ?? body?.error?.metadata?.raw
      return raw ? `${base} | provider: ${String(raw).slice(0, 300)}` : base
    }
    // Retry ladder: full request (require_parameters + reasoning) → exacto-only
    // (BOTH dropped — 2026-07-15 preview logs: exacto+require_parameters over-
    // constrained DeepSeek to "404 No endpoints found", so the old ladder fell
    // all the way to bare and silently lost the exacto quality routing) → BARE
    // (no exacto, no cache_control, no stream_options). A provider that 400s on
    // ANY optional extension must degrade, never knock the head over to the
    // fallback model (Grok-4.20 was silently DeepSeek all day, 2026-07-13).
    // A RATE LIMIT is not a rung on this ladder (full-chain diagnosis
    // 2026-08-16): stepping down re-sends the same tokens into the same
    // throttled minute — every rung 429s in turn and the turn dies. Wait the
    // provider's suggested delay (abortable) and retry the SAME request; only
    // non-429 failures descend the ladder.
    // Same-request 429 handling for EVERY rung (Codex P1 ×2 on PR #783): the
    // wait-loop retries the identical request; an exhausted 429 SURFACES
    // (descending would re-send the same tokens into the same throttled
    // minute); only non-429 errors return to the caller for a ladder step.
    const createWith429Wait = async (
      params: ChatCompletionCreateParamsStreaming,
    ): Promise<AsyncIterable<ChatCompletionChunk>> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.client.chat.completions.create(params, reqOptions) as AsyncIterable<ChatCompletionChunk>
        } catch (err) {
          if (args.signal?.aborted) throw err
          // Transient network/5xx failures also deserve an IDENTICAL-request
          // retry (Codex P2: maxRetries 0 removed the SDK's, and a one-off
          // outage must not read as parameter incompatibility and descend).
          const status = (err as { status?: number })?.status
          const message = err instanceof Error ? err.message : String(err)
          const transient = (typeof status === 'number' && (status >= 500 || status === 408 || status === 409))
            || /ECONNRESET|ETIMEDOUT|fetch failed|Connection error|network|timed? ?out/i.test(message)
          const rlDelay = rateLimitRetryDelaySeconds(err) ?? (transient ? 1.5 : null)
          if (rlDelay == null) throw err
          if (attempt >= 2) throw err // exhausted — surface, never descend
          console.warn(`[openai-adapter] ${modelSlug} retryable failure — waiting ${rlDelay}s (attempt ${attempt + 1})`)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, rlDelay * 1000)
            args.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
          })
          if (args.signal?.aborted) throw err
        }
      }
    }
    const isRateLimit = (err: unknown): boolean => rateLimitRetryDelaySeconds(err) != null
    let stream
    try {
      stream = await createWith429Wait({
        ...baseParams,
        ...providerPrefs,
        ...reasoningParam,
        ...samplerParam,
      } as ChatCompletionCreateParamsStreaming)
    } catch (err) {
      if (args.signal?.aborted || isRateLimit(err)) throw err
      console.warn(
        `[openai-adapter] ${modelSlug} rejected the full request — retrying without reasoning/require_parameters/sampler:`,
        errDetail(err),
      )
      try {
        // The middle rung drops provider_prefs/exacto/sampler but KEEPS an
        // EXPLICIT level (Codex P2): those are unrelated fields, and silently
        // finishing at the provider default while the turn's telemetry records
        // the picked depth is exactly the kind of quiet lie this feature exists
        // to avoid. Only the bare rung below gives the level up, and it says so.
        stream = await createWith429Wait({
          ...baseParams,
          ...(ownerEffort ? reasoningParam : {}),
        } as ChatCompletionCreateParamsStreaming)
      } catch (err2) {
        if (args.signal?.aborted || isRateLimit(err2)) throw err2
        console.warn(
          `[openai-adapter] ${modelSlug} rejected the standard request too — final bare retry (no exacto/cache_control/stream_options):`,
          errDetail(err2),
        )
        const bareParams = {
          model: args.apiModel,
          messages: toOpenAiMessages(args.system, args.messages, false),
          tools: args.tools.length ? toOpenAiTools(args.tools) : undefined,
          ...buildOpenAiFallbackToolChoice(args),
          stream: true as const,
          // Raw OpenAI: the PROVIDER DEFAULT reasoning_effort is what 400s a
          // tool-bearing request on gpt-5.6 — dropping our optional params
          // doesn't fix it, so the bare retry must still say 'none'.
          ...(this.rawOpenAi && args.tools.length > 0 ? { reasoning_effort: 'none' } : {}),
        }
        stream = await createWith429Wait(bareParams as ChatCompletionCreateParamsStreaming)
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
          // P8 — salvage recoverable malformed args (markdown fences, trailing
          // commas, single quotes, a truncated brace — which weak heads emit far
          // more than frontier models) so the call just succeeds. If it is truly
          // unrecoverable, emit the SINGLE-KEY `{_raw}` marker that
          // tool-contract.ts already converts into a retryable self-repair error
          // (never the misleading "unknown field _raw"). Pre-P8 that marker fired
          // even for trivially-fixable JSON, burning a whole extra model round.
          const repair = repairToolArgs(buf.args)
          const parsed: Record<string, unknown> = repair.ok ? repair.value : { _raw: repair.raw }
          yield { type: 'tool_input', id: buf.id, input: parsed }
        }
        toolBuffers.clear()
      }

      if (choice?.finish_reason === 'length' && AGENT_UNIFORM_SAMPLING) {
        yield { type: 'text_delta', text: TRUNCATION_NOTE }
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
        // Reasoning tokens (cost audit Phase 7) — observability only. Reasoning
        // models report these under completion_tokens_details.reasoning_tokens.
        const reasoningTokens =
          (chunk.usage as { completion_tokens_details?: { reasoning_tokens?: number } })
            .completion_tokens_details?.reasoning_tokens ?? 0
        yield {
          type: 'usage',
          inputTokens: Math.max(0, promptTokens - cachedTokens),
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheRead: cachedTokens,
          costUsd,
          reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
        }
      }
    }

    yield { type: 'done' }
  }
}

export function createOpenAiAdapter(): OpenAiAdapter {
  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key) throw new Error('OPENAI_API_KEY not configured')
  return new OpenAiAdapter(key, { rawOpenAi: true })
}

/**
 * xAI direct (api.x.ai, OpenAI-compatible). First-party serving for the Grok
 * head: no OpenRouter middleman, so no third-party tool-call parser between the
 * model and us — the same serving the Grok app gets. No OpenRouter extensions:
 * xAI caches prefixes automatically (no cache_control), reports no usage.cost,
 * and takes no `reasoning` request param — but the stream reader still surfaces
 * `reasoning_content` deltas if the model sends them, so live thinking works.
 */
export function createXaiAdapter(): OpenAiAdapter {
  const key = process.env.XAI_API_KEY?.trim()
  if (!key) throw new Error('XAI_API_KEY not configured')
  return new OpenAiAdapter(key, { baseURL: 'https://api.x.ai/v1', stickyCacheHeader: true })
}
