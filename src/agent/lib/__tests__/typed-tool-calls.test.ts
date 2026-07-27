/**
 * A round that TYPES its tool calls did no work — and that is the half the
 * owner felt before anyone measured it.
 *
 * His two reports on 2026-07-27 turned out to be one bug. Qwen, answering a
 * marketing turn, wrote seven calls as ```tool call fences and really made two.
 * He saw (a) machine syntax in his chat and (b) the think → tool → update → tool
 * rhythm replaced by a wall of text. (b) follows from (a): no call, no tool row,
 * no update.
 *
 * Stripping the markup alone would fix the look and keep the silence, so the
 * turn needs to KNOW. These pin the detector that tells it.
 */
import { describe, it, expect } from 'vitest'
import { typedToolCallsInsteadOfCalling } from '@/agent/lib/model-output-sanitize'

const qwenReply = [
  'বস, ৫০০০ টাকার নতুন Meta campaign চালাতে বলছেন — আগে ads অবস্থা দেখে নিচ্ছি।',
  '```tool call',
  '{"name": "marketing_report", "arguments": {"period": "last_7_days"}}',
  '```',
].join('\n')

describe('the round Qwen actually produced', () => {
  it('is caught when the model typed calls and made none', () => {
    expect(typedToolCallsInsteadOfCalling({ rawText: qwenReply, realToolCallCount: 0 })).toBe(true)
  })

  it('is NOT caught when the model also called properly — chatty is not broken', () => {
    expect(typedToolCallsInsteadOfCalling({ rawText: qwenReply, realToolCallCount: 2 })).toBe(false)
  })

  it('catches the older dialects too, so this net is not Qwen-only', () => {
    const xml = 'দেখছি।\n<tool_call>{"name":"get_orders"}</tool_call>'
    const json = 'দেখছি।\n{"type": "tool_use", "name": "recommend_ad_actions", "input": {}}'
    expect(typedToolCallsInsteadOfCalling({ rawText: xml, realToolCallCount: 0 })).toBe(true)
    expect(typedToolCallsInsteadOfCalling({ rawText: json, realToolCallCount: 0 })).toBe(true)
  })
})

describe('what must stay quiet', () => {
  it('ordinary prose is not a typed call', () => {
    expect(typedToolCallsInsteadOfCalling({
      rawText: 'বস, আজ ৭টা অর্ডার, ২টা পেন্ডিং।',
      realToolCallCount: 0,
    })).toBe(false)
  })

  it('fenced JSON the owner asked for is not a typed call', () => {
    expect(typedToolCallsInsteadOfCalling({
      rawText: 'এই যে JSON:\n```json\n{"orderId": "AL-0319"}\n```',
      realToolCallCount: 0,
    })).toBe(false)
  })

  it('an empty round is the empty-round guard’s job, not this one', () => {
    expect(typedToolCallsInsteadOfCalling({ rawText: '', realToolCallCount: 0 })).toBe(false)
  })
})
