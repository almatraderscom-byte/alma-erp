import Anthropic from '@anthropic-ai/sdk'
import type { NeutralMsg, NeutralTool, NeutralToolChoice, ProviderAdapter, TurnEvent } from '@/agent/lib/models/types'
import { resolveGenerationParams } from '@/agent/lib/models/generation-params'

/**
 * Phase 6 (one turn engine) — native Anthropic as a PROVIDER ADAPTER.
 *
 * Until now Anthropic heads ran their own parallel loop (core.ts) while every
 * other provider ran the neutral adapter loop — two implementations of state,
 * verification, cards, budgets and salvage that had to be patched twice
 * (Phase 4's missing hooks were found exactly there). This adapter lets the
 * SINGLE orchestrator own all of that; only Anthropic request shaping lives
 * here, mirroring how Grok/Gemini shaping lives in their adapters.
 *
 * Anthropic-specific care:
 *  - Prompt caching: cache_control breakpoints on the last tool + the system
 *    block (the stable prefix), same policy as the native loop.
 *  - Extended thinking across tool rounds: the API requires the assistant
 *    turn's thinking block (text + signature) to be replayed verbatim before
 *    its tool_use blocks. The neutral history can't carry it natively, so the
 *    round's thinking rides the FIRST tool call's `thoughtSignature` as JSON
 *    — the exact mechanism Gemini already uses for its own signatures.
 *  - tool_choice: named/required force-calls are INCOMPATIBLE with extended
 *    thinking (API 400) — thinking wins, the binding is dropped (roadmap §D
 *    binding is best-effort by design).
 *  - Role alternation: consecutive assistant text + toolCalls messages merge
 *    into ONE assistant message; consecutive tool results merge into ONE user
 *    message — the strict alternation the API demands.
 *  - Vision: a tool result carrying `image` becomes a real image block ahead
 *    of the JSON text, so the model SEES live-browser screenshots.
 */

const globalForAnthropicAdapter = globalThis as unknown as { anthropicAdapterClient?: Anthropic }

function client(): Anthropic {
  if (!globalForAnthropicAdapter.anthropicAdapterClient) {
    globalForAnthropicAdapter.anthropicAdapterClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    })
  }
  return globalForAnthropicAdapter.anthropicAdapterClient
}

/** Round-trip envelope for a round's thinking block (rides thoughtSignature). */
interface ThinkingEnvelope {
  kind: 'anthropic_thinking'
  t: string
  s: string
}

export function encodeThinkingEnvelope(thinking: string, signature: string): string {
  return JSON.stringify({ kind: 'anthropic_thinking', t: thinking, s: signature } satisfies ThinkingEnvelope)
}

export function decodeThinkingEnvelope(raw: string | undefined): ThinkingEnvelope | null {
  if (!raw || !raw.startsWith('{')) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ThinkingEnvelope>
    if (parsed.kind === 'anthropic_thinking' && typeof parsed.t === 'string' && typeof parsed.s === 'string') {
      return parsed as ThinkingEnvelope
    }
  } catch { /* not ours (e.g. a Gemini signature) — ignore */ }
  return null
}

/**
 * Neutral history → Anthropic messages with strict user/assistant alternation.
 * Exported for unit tests.
 */
export function toAnthropicMessages(messages: NeutralMsg[]): Anthropic.Messages.MessageParam[] {
  const out: Anthropic.Messages.MessageParam[] = []

  const pushBlocks = (role: 'user' | 'assistant', blocks: Anthropic.Messages.ContentBlockParam[]) => {
    const last = out[out.length - 1]
    if (last && last.role === role && Array.isArray(last.content)) {
      ;(last.content as Anthropic.Messages.ContentBlockParam[]).push(...blocks)
      return
    }
    out.push({ role, content: blocks })
  }

  for (const msg of messages) {
    if ('content' in msg && typeof msg.content === 'string') {
      if (msg.content.trim()) pushBlocks(msg.role, [{ type: 'text', text: msg.content }])
      continue
    }

    if ('toolCalls' in msg) {
      const blocks: Anthropic.Messages.ContentBlockParam[] = []
      // Replay the round's thinking block (extended-thinking contract): it was
      // stashed on the first tool call's thoughtSignature by streamTurn below.
      const env = decodeThinkingEnvelope(msg.toolCalls[0]?.thoughtSignature)
      if (env) blocks.push({ type: 'thinking', thinking: env.t, signature: env.s })
      for (const tc of msg.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      }
      if (blocks.length > 0) pushBlocks('assistant', blocks)
      continue
    }

    if (msg.role === 'tool') {
      // Vision: hand the model a REAL image block (screenshot) + the JSON text
      // without the base64 (undecodable inline and ~100KB of waste).
      const img =
        msg.result && typeof msg.result === 'object' && 'image' in msg.result
          ? (msg.result as { image?: { data?: unknown; mediaType?: unknown } }).image
          : undefined
      const imgData = img && typeof img.data === 'string' ? img.data : ''
      const imgMime = img && typeof img.mediaType === 'string' ? (img.mediaType as string) : 'image/jpeg'
      let payload: unknown = msg.result
      if (imgData) {
        const { image: _omit, ...rest } = msg.result as Record<string, unknown>
        payload = rest
      }
      const content: Anthropic.Messages.ToolResultBlockParam['content'] = imgData
        ? [
            { type: 'image', source: { type: 'base64', media_type: imgMime as 'image/jpeg', data: imgData } },
            { type: 'text', text: JSON.stringify(payload) },
          ]
        : JSON.stringify(payload)
      pushBlocks('user', [{ type: 'tool_result', tool_use_id: msg.toolCallId, content }])
    }
  }

  return out
}

/** Anthropic tool_choice shaping (pure, unit-tested). Thinking wins over force-calls. */
export function buildAnthropicToolChoice(args: {
  hasTools: boolean
  toolChoice?: NeutralToolChoice
  parallelToolCalls?: boolean
  thinkingEnabled: boolean
}): Anthropic.Messages.ToolChoice | undefined {
  if (!args.hasTools) return undefined
  const disableParallel = args.parallelToolCalls === false
  const tc = args.toolChoice
  if (tc === 'none') return { type: 'none' }
  const forced = tc === 'required' || (typeof tc === 'object' && tc !== null)
  if (forced && !args.thinkingEnabled) {
    return typeof tc === 'object'
      ? { type: 'tool', name: tc.name, disable_parallel_tool_use: disableParallel || undefined }
      : { type: 'any', disable_parallel_tool_use: disableParallel || undefined }
  }
  // auto (or forced-but-thinking → downgraded to auto per the API constraint)
  if (disableParallel) return { type: 'auto', disable_parallel_tool_use: true }
  return undefined
}

export class AnthropicAdapter implements ProviderAdapter {
  async *streamTurn(args: {
    apiModel: string
    system: string
    messages: NeutralMsg[]
    tools: NeutralTool[]
    signal?: AbortSignal
    thinking?: 'adaptive' | 'level' | 'none'
    toolChoice?: NeutralToolChoice
    parallelToolCalls?: boolean
  }): AsyncGenerator<TurnEvent> {
    const thinkingEnabled = args.thinking !== 'none' && args.thinking !== undefined

    const tools: Anthropic.Messages.ToolUnion[] = args.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema as Anthropic.Messages.Tool['input_schema'],
      // Cache breakpoint after the (stable) tool definitions — same policy as
      // the native loop: tools + system form the cached prefix.
      ...(i === args.tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }))

    // P9 — shared sampling/output contract. gen is {} unless AGENT_UNIFORM_SAMPLING
    // is on; temperature is only present for non-thinking models (extended thinking
    // requires temperature=1), so it is never added to an adaptive-thinking call.
    const gen = resolveGenerationParams({ thinking: args.thinking })
    const buildParams = (withThinking: boolean): Anthropic.Messages.MessageCreateParamsStreaming => ({
      model: args.apiModel,
      max_tokens: gen.maxTokens ?? 8192,
      ...(gen.temperature !== undefined ? { temperature: gen.temperature, top_p: gen.topP } : {}),
      ...(withThinking ? { thinking: { type: 'adaptive' as const } } : {}),
      system: [{ type: 'text', text: args.system, cache_control: { type: 'ephemeral' } }],
      ...(tools.length > 0 ? { tools } : {}),
      messages: toAnthropicMessages(args.messages),
      ...(tools.length > 0
        ? (() => {
            const tc = buildAnthropicToolChoice({
              hasTools: true,
              toolChoice: args.toolChoice,
              parallelToolCalls: args.parallelToolCalls,
              thinkingEnabled: withThinking,
            })
            return tc ? { tool_choice: tc } : {}
          })()
        : {}),
      stream: true,
    })

    // Retry ladder (mirrors the OpenAI adapter): full request → thinking off →
    // bare (no shaping). A rejected parameter degrades the request, never the head.
    const attempts: Array<Anthropic.Messages.MessageCreateParamsStreaming> = [
      buildParams(thinkingEnabled),
      ...(thinkingEnabled ? [buildParams(false)] : []),
    ]

    let lastErr: unknown
    for (let attempt = 0; attempt < attempts.length; attempt++) {
      try {
        yield* this.streamOnce(attempts[attempt], args.signal)
        return
      } catch (err) {
        lastErr = err
        const msg = err instanceof Error ? err.message : String(err)
        // Only shape-rejections fall down the ladder; real failures surface.
        if (attempt < attempts.length - 1 && /thinking|tool_choice|invalid_request/i.test(msg)) {
          console.warn(`[anthropic-adapter] attempt ${attempt + 1} rejected (${msg.slice(0, 120)}) — retrying reduced`)
          continue
        }
        throw err
      }
    }
    throw lastErr
  }

  private async *streamOnce(
    params: Anthropic.Messages.MessageCreateParamsStreaming,
    signal?: AbortSignal,
  ): AsyncGenerator<TurnEvent> {
    const stream = await client().messages.create(params, { signal })

    // Round state: thinking text + signature (for the envelope), tool calls.
    let thinkingText = ''
    let thinkingSignature = ''
    const toolCalls: Array<{ id: string; name: string; json: string }> = []
    let activeTool: { id: string; name: string; json: string } | null = null
    let activeBlockType: string | null = null

    for await (const event of stream) {
      if (signal?.aborted) break
      if (event.type === 'message_start') {
        const u = event.message.usage
        yield {
          type: 'usage',
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheRead: (u as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0,
          cacheWrite: (u as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0,
        }
      } else if (event.type === 'message_delta') {
        if (event.usage?.output_tokens) {
          yield { type: 'usage', inputTokens: 0, outputTokens: event.usage.output_tokens }
        }
      } else if (event.type === 'content_block_start') {
        activeBlockType = event.content_block.type
        if (event.content_block.type === 'tool_use') {
          activeTool = { id: event.content_block.id, name: event.content_block.name, json: '' }
          yield { type: 'tool_start', id: activeTool.id, name: activeTool.name }
        }
      } else if (event.type === 'content_block_delta') {
        const d = event.delta
        if (d.type === 'text_delta') {
          yield { type: 'text_delta', text: d.text }
        } else if (d.type === 'thinking_delta') {
          thinkingText += d.thinking
          yield { type: 'thinking_delta', text: d.thinking }
        } else if (d.type === 'signature_delta') {
          thinkingSignature += d.signature
        } else if (d.type === 'input_json_delta' && activeTool) {
          activeTool.json += d.partial_json
        }
      } else if (event.type === 'content_block_stop') {
        if (activeBlockType === 'tool_use' && activeTool) {
          toolCalls.push(activeTool)
          activeTool = null
        }
        activeBlockType = null
      }
    }

    // Emit tool inputs at the end of the stream, with the round's thinking
    // envelope on the FIRST call so the next round can replay it verbatim.
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]
      let input: Record<string, unknown> = {}
      try {
        input = tc.json ? (JSON.parse(tc.json) as Record<string, unknown>) : {}
      } catch {
        console.warn(`[anthropic-adapter] unparseable tool input for ${tc.name}`)
      }
      yield {
        type: 'tool_input',
        id: tc.id,
        input,
        ...(i === 0 && thinkingText && thinkingSignature
          ? { thoughtSignature: encodeThinkingEnvelope(thinkingText, thinkingSignature) }
          : {}),
      }
    }

    yield { type: 'done' }
  }
}

export function createAnthropicAdapter(): ProviderAdapter {
  return new AnthropicAdapter()
}
