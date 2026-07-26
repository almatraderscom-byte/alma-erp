/**
 * Owner saw this twice on 2026-07-27, on the Qwen head: the model wrote its tool
 * call as prose and it was rendered to him verbatim inside an otherwise normal
 * Bangla reply.
 */
import { describe, it, expect } from 'vitest'
import { stripLeakedToolCalls } from '@/agent/lib/strip-leaked-tool-calls'

describe('leaked tool-call text', () => {
  it('removes the exact block he saw, and keeps the sentence around it', () => {
    const input = [
      'বস, সব product-এর alt text একসাথে ঠিক করতে বলছেন — catalog audit শুরু করছি।',
      '',
      '<get_website_catalog> <arg_key>scope</arg_key> <arg_value>all</arg_value> </tool_call>',
      '',
      'প্রথমে catalog দেখে নিই কতগুলো product আছে।',
    ].join('\n')
    const out = stripLeakedToolCalls(input)
    expect(out.count).toBe(1)
    expect(out.toolNames).toEqual(['get_website_catalog'])
    expect(out.text).not.toContain('arg_key')
    expect(out.text).not.toContain('tool_call')
    expect(out.text).toContain('catalog audit শুরু করছি')
    expect(out.text).toContain('প্রথমে catalog দেখে নিই')
  })

  it('handles the second shape he saw, with a url argument', () => {
    const out = stripLeakedToolCalls(
      'বস, alt text বসাতে বলছেন।\n<fetch_website_page> <arg_key>url</arg_key> <arg_value>https://almatraders.com/product/product-code-13</arg_value> </tool_call>\nদেখে নিচ্ছি।',
    )
    expect(out.count).toBe(1)
    expect(out.toolNames).toEqual(['fetch_website_page'])
    expect(out.text).not.toContain('almatraders.com/product/product-code-13')
  })

  it('removes several, and reports each tool once', () => {
    const out = stripLeakedToolCalls(
      'ক <a_tool> <arg_key>x</arg_key> </tool_call> খ <a_tool> <arg_key>y</arg_key> </tool_call> গ <b_tool> </tool_call>',
    )
    expect(out.count).toBe(3)
    expect(out.toolNames).toEqual(['a_tool', 'b_tool'])
  })

  it('handles the generic wrapper form', () => {
    const out = stripLeakedToolCalls('আগে\n<tool_call> {"name":"get_orders"} </tool_call>\nপরে')
    expect(out.count).toBe(1)
    expect(out.toolNames).toEqual([])
    // The block sat on its own line; what is left is an ordinary paragraph break.
    expect(out.text).toBe('আগে\n\nপরে')
  })

  it('leaves ordinary prose with angle brackets alone', () => {
    for (const text of [
      'দাম < ৫০০ টাকা হলে অর্ডার নেবেন।',
      'HTML-এ <div> ট্যাগটা কীভাবে লিখব?',
      'a < b এবং b > c',
      'বস, ৮৭টা product ঠিক আছে।',
    ]) {
      const out = stripLeakedToolCalls(text)
      expect(out.count).toBe(0)
      expect(out.text).toBe(text)
    }
  })

  it('is cheap when there is nothing to do', () => {
    const text = 'কাজ শেষ।'
    expect(stripLeakedToolCalls(text)).toEqual({ text, toolNames: [], count: 0 })
    expect(stripLeakedToolCalls('')).toEqual({ text: '', toolNames: [], count: 0 })
  })
})
