/**
 * SEEN LIVE 2026-07-27 on the Qwen head. The reply Boss read contained:
 *
 *   প্রথমে catalog দেখে নিই কতগুলো product আছে, তারপর audit চালাবো।
 *   <get_website_catalog> <arg_key>scope</arg_key> <arg_value>all</arg_value> </tool_call>
 *
 * The first case below is that text, unchanged. The rest of the suite is the
 * other half of the job: ordinary prose with angle brackets in it must come
 * back untouched, or the repair would be worse than the defect.
 */
import { describe, expect, it } from 'vitest'
import { stripToolCallMarkup } from '@/agent/lib/model-output-sanitize'

describe('tool-call markup never reaches the owner', () => {
  it('removes the exact leak from his screen', () => {
    const seen =
      'প্রথমে catalog দেখে নিই কতগুলো product আছে, তারপর audit চালাবো।\n\n'
      + '<get_website_catalog> <arg_key>scope</arg_key> <arg_value>all</arg_value> </tool_call>'
    expect(stripToolCallMarkup(seen)).toBe('প্রথমে catalog দেখে নিই কতগুলো product আছে, তারপর audit চালাবো।')
  })

  it('removes a well-formed <tool_call> block', () => {
    const t = 'বস, দেখছি।\n<tool_call>{"name":"get_orders","arguments":{}}</tool_call>\nএক মিনিট।'
    expect(stripToolCallMarkup(t)).toBe('বস, দেখছি।\n\nএক মিনিট।')
  })

  it('removes a block a cut-off stream never closed', () => {
    const t = 'বস, অর্ডার দেখছি।\n<tool_call>{"name":"get_orders"'
    expect(stripToolCallMarkup(t)).toBe('বস, অর্ডার দেখছি।')
  })

  it('removes the DeepSeek/Qwen sentinels', () => {
    expect(stripToolCallMarkup('ঠিক আছে <|tool_calls_begin|> বাকিটা')).toBe('ঠিক আছে  বাকিটা')
  })

  it('leaves clean prose exactly as it is', () => {
    const t = 'বস, ৫০টা product-এর মধ্যে ৪২টায় সমস্যা — প্রথম ১০টা পাঠালাম।'
    expect(stripToolCallMarkup(t)).toBe(t)
  })

  it('leaves ordinary angle brackets alone', () => {
    const t = 'সাইজ চার্ট: বুক <36 ইঞ্চি → S, 36–40 → M। আর 5 < 10 সবসময়ই সত্য।'
    expect(stripToolCallMarkup(t)).toBe(t)
  })

  it('leaves a code block Boss asked for alone', () => {
    const t = 'এই HTML টা বসান:\n```html\n<img src="/p.jpg" alt="নীল পাঞ্জাবি"/>\n```'
    expect(stripToolCallMarkup(t)).toBe(t)
  })

  it('a message that was ONLY markup becomes empty, not garbage', () => {
    const t = '<tool_call>{"name":"get_orders","arguments":{}}</tool_call>'
    expect(stripToolCallMarkup(t)).toBe('')
  })

  it('is a no-op on empty input', () => {
    expect(stripToolCallMarkup('')).toBe('')
  })
})

describe('the JSON shape (owner’s own chat, 2026-07-27)', () => {
  it('strips the exact block he was shown while asking about ad spend', () => {
    const input = [
      'বস, আপনার অ্যাডস অ্যাকাউন্টের লাইভ খরচ আর লিমিট চেক করছি।',
      '',
      '{"type": "tool_use", "id": "tooluse_fPsTqJdFhXJz8Qm9Kw2LxN", "name": "recommend_ad_actions", "input": {}}',
    ].join('\n')
    const out = stripToolCallMarkup(input)
    expect(out).not.toContain('tool_use')
    expect(out).not.toContain('tooluse_fPsTqJdFhXJz8Qm9Kw2LxN')
    expect(out).toContain('লাইভ খরচ আর লিমিট চেক করছি')
  })

  it('strips one with a populated input object', () => {
    const out = stripToolCallMarkup(
      'দেখছি।\n{"type":"tool_use","id":"x1","name":"get_orders","input":{"limit":10,"status":"pending"}}\nশেষ।',
    )
    expect(out).not.toContain('get_orders')
    expect(out).toContain('দেখছি')
    expect(out).toContain('শেষ')
  })

  it('leaves ordinary JSON he asked for completely alone', () => {
    for (const text of [
      '{"name":"ALMA","type":"shop","orders":42}',
      'API উত্তর: {"type":"product","id":"7-b","price":1200}',
      '{"type":"tool_belt","id":"x"}',
    ]) {
      expect(stripToolCallMarkup(text)).toBe(text)
    }
  })
})
