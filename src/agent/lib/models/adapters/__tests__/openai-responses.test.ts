import { describe, expect, it } from 'vitest'
import {
  encodeReasoningSignature,
  lunaReasoningEffort,
  mapResponsesStream,
  toResponsesInput,
  toResponsesToolChoice,
  toResponsesTools,
} from '@/agent/lib/models/adapters/openai'
import type { NeutralMsg, TurnEvent } from '@/agent/lib/models/types'

async function collect(events: unknown[]): Promise<TurnEvent[]> {
  async function* fake() { for (const e of events) yield e }
  const out: TurnEvent[] = []
  for await (const ev of mapResponsesStream(fake())) out.push(ev)
  return out
}

describe('openai Responses API mapping (Luna visible thought)', () => {
  it('round-trips tool calls as function_call / function_call_output items', () => {
    const messages: NeutralMsg[] = [
      { role: 'user', content: 'stock koto?' },
      { role: 'assistant', toolCalls: [{ id: 'call_1', name: 'get_inventory_status', input: { businessId: 'ALMA_LIFESTYLE' } }] },
      { role: 'tool', toolCallId: 'call_1', name: 'get_inventory_status', result: { ok: true, image: 'x'.repeat(10), note: 'kept' } },
      { role: 'assistant', content: 'হয়ে গেছে' },
    ]
    const input = toResponsesInput(messages)
    expect(input).toEqual([
      { role: 'user', content: 'stock koto?' },
      { type: 'function_call', call_id: 'call_1', name: 'get_inventory_status', arguments: '{"businessId":"ALMA_LIFESTYLE"}' },
      // base64 image stripped, like the chat path
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true,"note":"kept"}' },
      { role: 'assistant', content: 'হয়ে গেছে' },
    ])
  })

  it('emits flat function tools and maps tool_choice', () => {
    const tools = toResponsesTools([{ name: 't', description: 'd', schema: { type: 'object' } }])
    expect(tools[0]).toMatchObject({ type: 'function', name: 't', description: 'd', strict: false })
    expect((tools[0] as { function?: unknown }).function).toBeUndefined()
    expect(toResponsesToolChoice(undefined)).toBeUndefined()
    expect(toResponsesToolChoice('auto')).toBeUndefined()
    expect(toResponsesToolChoice('required')).toBe('required')
    expect(toResponsesToolChoice({ name: 'x' })).toEqual({ type: 'function', name: 'x' })
  })

  it('streams reasoning summaries as thinking_delta and text as text_delta', async () => {
    const out = await collect([
      { type: 'response.reasoning_summary_text.delta', delta: 'ভাবছি — stock আগে' },
      { type: 'response.output_text.delta', delta: 'বস, ' },
      { type: 'response.output_text.delta', delta: 'দেখছি।' },
      { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 12 } } } },
    ])
    expect(out).toEqual([
      { type: 'thinking_delta', text: 'ভাবছি — stock আগে' },
      { type: 'text_delta', text: 'বস, ' },
      { type: 'text_delta', text: 'দেখছি।' },
      { type: 'usage', inputTokens: 60, outputTokens: 20, cacheRead: 40, reasoningTokens: 12 },
      { type: 'done' },
    ])
  })

  it('emits tool_start on item.added and whole-arguments tool_input on item.done', async () => {
    const out = await collect([
      { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_9', name: 'get_orders' } },
      { type: 'response.function_call_arguments.delta', item_id: 'x', delta: '{"limit"' },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_9', name: 'get_orders', arguments: '{"limit":5}' } },
      { type: 'response.completed', response: {} },
    ])
    expect(out).toEqual([
      { type: 'tool_start', id: 'call_9', name: 'get_orders' },
      { type: 'tool_input', id: 'call_9', input: { limit: 5 } },
      { type: 'done' },
    ])
  })

  // Codex P1: stateless (store:false) tool rounds must replay the encrypted
  // reasoning item that preceded the function call.
  it('carries encrypted reasoning through thoughtSignature and replays it before the call', async () => {
    const out = await collect([
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC' } },
      { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_2', name: 'get_orders' } },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_2', name: 'get_orders', arguments: '{}' } },
      { type: 'response.completed', response: {} },
    ])
    const toolInput = out.find((e) => e.type === 'tool_input') as { thoughtSignature?: string }
    expect(toolInput.thoughtSignature).toBe(encodeReasoningSignature('rs_1', 'ENC'))

    const input = toResponsesInput([
      { role: 'assistant', toolCalls: [{ id: 'call_2', name: 'get_orders', input: {}, thoughtSignature: toolInput.thoughtSignature }] },
      { role: 'tool', toolCallId: 'call_2', name: 'get_orders', result: { ok: true } },
    ])
    expect(input).toEqual([
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] },
      { type: 'function_call', call_id: 'call_2', name: 'get_orders', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_2', output: '{"ok":true}' },
    ])
    // A Gemini signature in mixed history is NOT ours — never replayed as an item.
    const foreign = toResponsesInput([
      { role: 'assistant', toolCalls: [{ id: 'c', name: 't', input: {}, thoughtSignature: 'gemini-opaque-bytes' }] },
    ])
    expect(foreign).toEqual([{ type: 'function_call', call_id: 'c', name: 't', arguments: '{}' }])
  })

  // Codex P2: a max_output_tokens round is still billed.
  it('records usage from response.incomplete', async () => {
    const out = await collect([
      { type: 'response.output_text.delta', delta: 'অর্ধেক' },
      { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 50, output_tokens: 10, output_tokens_details: { reasoning_tokens: 4 } } } },
    ])
    expect(out).toContainEqual({ type: 'usage', inputTokens: 50, outputTokens: 10, cacheRead: 0, reasoningTokens: 4 })
  })

  it('throws on response.failed so the turn loop can fall back', async () => {
    await expect(collect([
      { type: 'response.failed', response: { error: { message: 'boom' } } },
    ])).rejects.toThrow(/boom/)
  })

  it('parses rate-limit retry delays and rejects other errors', async () => {
    const { rateLimitRetryDelaySeconds } = await import('@/agent/lib/models/adapters/openai')
    const rl = Object.assign(new Error(
      'Rate limit reached for gpt-5.6-luna in organization org-x on tokens per min (TPM): Limit 200000, Used 154191, Requested 60900. Please try again in 4.527s.',
    ), { status: 429 })
    expect(rateLimitRetryDelaySeconds(rl)).toBeCloseTo(5.027, 2)
    expect(rateLimitRetryDelaySeconds(Object.assign(new Error('Rate limit reached'), { status: 429 }))).toBe(5.5)
    // The 14.8s ask the owner captured live MUST be honoured in full.
    expect(rateLimitRetryDelaySeconds(Object.assign(new Error('rate limit. Please try again in 14.803s.'), { status: 429 }))).toBeCloseTo(15.303, 2)
    // Cap: a "try again in 1200s" answer must not stall the turn.
    expect(rateLimitRetryDelaySeconds(Object.assign(new Error('rate limit — try again in 1200s'), { status: 429 }))).toBe(61)
    expect(rateLimitRetryDelaySeconds(Object.assign(new Error('Bad request'), { status: 400 }))).toBeNull()
  })

  it('effort env defaults to medium and rejects junk', () => {
    const old = process.env.LUNA_REASONING_EFFORT
    delete process.env.LUNA_REASONING_EFFORT
    expect(lunaReasoningEffort()).toBe('medium')
    process.env.LUNA_REASONING_EFFORT = 'high'
    expect(lunaReasoningEffort()).toBe('high')
    process.env.LUNA_REASONING_EFFORT = 'low'
    expect(lunaReasoningEffort()).toBe('low')
    process.env.LUNA_REASONING_EFFORT = 'garbage'
    expect(lunaReasoningEffort()).toBe('medium')
    if (old === undefined) delete process.env.LUNA_REASONING_EFFORT
    else process.env.LUNA_REASONING_EFFORT = old
  })
})
