import { describe, expect, it } from 'vitest'
import {
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

  it('throws on response.failed so the turn loop can fall back', async () => {
    await expect(collect([
      { type: 'response.failed', response: { error: { message: 'boom' } } },
    ])).rejects.toThrow(/boom/)
  })

  it('effort env defaults to low and rejects junk', () => {
    const old = process.env.LUNA_REASONING_EFFORT
    delete process.env.LUNA_REASONING_EFFORT
    expect(lunaReasoningEffort()).toBe('low')
    process.env.LUNA_REASONING_EFFORT = 'high'
    expect(lunaReasoningEffort()).toBe('high')
    process.env.LUNA_REASONING_EFFORT = 'garbage'
    expect(lunaReasoningEffort()).toBe('low')
    if (old === undefined) delete process.env.LUNA_REASONING_EFFORT
    else process.env.LUNA_REASONING_EFFORT = old
  })
})
