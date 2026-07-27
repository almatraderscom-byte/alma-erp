/**
 * The fifth dialect, and the last one worth chasing individually.
 *
 * The owner's own chat, 2026-07-27: he asked for a ৫০০০ টাকা Meta campaign, the
 * turn was routed to Qwen (marketing head, a cost decision), and Qwen typed its
 * tool calls as markdown instead of calling them:
 *
 *   ```tool call
 *   {"name": "marketing_report", "arguments": {"period": "last_7_days"}}
 *   ```
 *
 * Four patterns already existed and all four missed it, because every one of
 * them is anchored on angle brackets or on `"type":"tool_use"`. So this rule is
 * written GENERICALLY — by the SHAPE of a fenced tool call rather than by one
 * model's spelling — and these tests hold both halves of that promise: the
 * machine syntax goes, and the owner's own fenced JSON stays.
 */
import { describe, it, expect } from 'vitest'
import { stripToolCallMarkup } from '@/agent/lib/model-output-sanitize'

describe('the shape Qwen produced', () => {
  it('removes a ```tool call fence and keeps the Bangla around it', () => {
    const reply = [
      'বস, ৫০০০ টাকার নতুন Meta campaign চালাতে বলছেন — আগে ads অবস্থা দেখে নিচ্ছি।',
      '',
      '```tool call',
      '{"name": "marketing_report", "arguments": {"period": "last_7_days"}}',
      '```',
      '',
      'তারপর audience দেখব।',
    ].join('\n')
    const out = stripToolCallMarkup(reply)
    expect(out).toContain('Meta campaign চালাতে বলছেন')
    expect(out).toContain('তারপর audience দেখব')
    expect(out).not.toContain('marketing_report')
    expect(out).not.toContain('```')
  })

  it('removes several in one reply — he was shown seven', () => {
    const reply = [
      'বস, data আনছি।',
      '```tool call',
      '{"name": "recommend_ad_actions", "arguments": {}}',
      '```',
      '```tool call',
      '{"name": "list_audiences", "arguments": {}}',
      '```',
      '```tool call',
      '{"name": "get_customer_segments", "arguments": {"segment": "all"}}',
      '```',
    ].join('\n')
    const out = stripToolCallMarkup(reply)
    expect(out).toBe('বস, data আনছি।')
  })

  it('catches the spellings a different model will invent', () => {
    for (const tag of ['tool_call', 'tool-calls', 'function_call', 'json tool call']) {
      const out = stripToolCallMarkup(`ঠিক আছে।\n\`\`\`${tag}\n{"name":"get_orders","arguments":{}}\n\`\`\``)
      expect(out).not.toContain('get_orders')
    }
  })

  it('catches an untagged fence whose body is a tool call', () => {
    const out = stripToolCallMarkup('দেখছি।\n```\n{"name": "get_orders", "input": {"status": "pending"}}\n```')
    expect(out).not.toContain('get_orders')
    expect(out).toContain('দেখছি')
  })

  it('survives a stream cut in the middle of the fence', () => {
    const out = stripToolCallMarkup('বস, দেখছি।\n```tool call\n{"name": "get_orders", "argum')
    expect(out).toBe('বস, দেখছি।')
  })
})

describe('what must NOT be touched', () => {
  it('leaves fenced JSON the owner actually asked for', () => {
    const reply = 'এই যে আপনার order-এর JSON:\n```json\n{"orderId": "AL-0319", "total": 1720}\n```'
    expect(stripToolCallMarkup(reply)).toBe(reply)
  })

  it('leaves code the owner asked for, even when it mentions tools', () => {
    const reply = 'এই ফাংশনটা tool call করে:\n```ts\nconst r = await runTool("get_orders")\n```'
    expect(stripToolCallMarkup(reply)).toBe(reply)
  })

  it('leaves ordinary prose untouched and costs nothing', () => {
    const reply = 'বস, আজ ৭টা অর্ডার, ২টা পেন্ডিং।'
    expect(stripToolCallMarkup(reply)).toBe(reply)
  })
})
