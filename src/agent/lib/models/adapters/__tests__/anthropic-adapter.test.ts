import { describe, it, expect } from 'vitest'
import {
  toAnthropicMessages,
  buildAnthropicToolChoice,
  encodeThinkingEnvelope,
  decodeThinkingEnvelope,
} from '../anthropic'
import { appendToolExchange } from '../../neutral'
import type { NeutralMsg } from '../../types'

/**
 * Phase 6 — the native-Anthropic adapter's pure request shaping. The neutral
 * loop is provider-blind; everything Anthropic-specific must round-trip here.
 */

describe('toAnthropicMessages', () => {
  it('merges assistant text + toolCalls into ONE message (strict alternation)', () => {
    const msgs: NeutralMsg[] = [
      { role: 'user', content: 'পোস্ট করো' },
      { role: 'assistant', content: 'দেখছি, বস…' },
      { role: 'assistant', toolCalls: [{ id: 't1', name: 'get_product', input: { query: '720' } }] },
      { role: 'tool', toolCallId: 't1', name: 'get_product', result: { success: true } },
    ]
    const out = toAnthropicMessages(msgs)
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    const assistant = out[1].content as Array<{ type: string }>
    expect(assistant.map((b) => b.type)).toEqual(['text', 'tool_use'])
  })

  it('merges consecutive tool results into ONE user message', () => {
    const msgs: NeutralMsg[] = [
      { role: 'assistant', toolCalls: [
        { id: 'a', name: 'x', input: {} },
        { id: 'b', name: 'y', input: {} },
      ] },
      { role: 'tool', toolCallId: 'a', name: 'x', result: { ok: 1 } },
      { role: 'tool', toolCallId: 'b', name: 'y', result: { ok: 2 } },
    ]
    const out = toAnthropicMessages(msgs)
    expect(out).toHaveLength(2)
    expect(out[1].role).toBe('user')
    expect((out[1].content as unknown[]).length).toBe(2)
  })

  it('replays the round thinking block from the envelope before tool_use', () => {
    const env = encodeThinkingEnvelope('আগে প্রোডাক্ট দেখি', 'sig123')
    const msgs: NeutralMsg[] = [
      { role: 'assistant', toolCalls: [{ id: 't1', name: 'get_product', input: {}, thoughtSignature: env }] },
      { role: 'tool', toolCallId: 't1', name: 'get_product', result: {} },
    ]
    const out = toAnthropicMessages(msgs)
    const blocks = out[0].content as Array<{ type: string; thinking?: string; signature?: string }>
    expect(blocks[0].type).toBe('thinking')
    expect(blocks[0].thinking).toBe('আগে প্রোডাক্ট দেখি')
    expect(blocks[0].signature).toBe('sig123')
    expect(blocks[1].type).toBe('tool_use')
  })

  it('a Gemini thoughtSignature is NOT mistaken for the envelope', () => {
    expect(decodeThinkingEnvelope('opaque-gemini-signature')).toBeNull()
    expect(decodeThinkingEnvelope('{"foo":1}')).toBeNull()
    const env = encodeThinkingEnvelope('t', 's')
    expect(decodeThinkingEnvelope(env)).toEqual({ kind: 'anthropic_thinking', t: 't', s: 's' })
  })

  it('a tool result with an image becomes an image block + JSON text without the base64', () => {
    const msgs: NeutralMsg[] = [
      { role: 'assistant', toolCalls: [{ id: 't1', name: 'live_browser_look', input: {} }] },
      {
        role: 'tool', toolCallId: 't1', name: 'live_browser_look',
        result: { success: true, data: { currentUrl: 'https://x.com' }, image: { data: 'BASE64DATA', mediaType: 'image/jpeg' } },
      },
    ]
    const out = toAnthropicMessages(msgs)
    const toolResult = (out[1].content as Array<{ type: string; content?: Array<{ type: string; text?: string }> }>)[0]
    expect(toolResult.type).toBe('tool_result')
    const inner = toolResult.content as Array<{ type: string; text?: string }>
    expect(inner[0].type).toBe('image')
    expect(inner[1].type).toBe('text')
    expect(inner[1].text).not.toContain('BASE64DATA')
    expect(inner[1].text).toContain('currentUrl')
  })
})

describe('buildAnthropicToolChoice', () => {
  it('maps the neutral dial; forced calls are dropped while thinking is on (API constraint)', () => {
    expect(buildAnthropicToolChoice({ hasTools: false, thinkingEnabled: true })).toBeUndefined()
    expect(buildAnthropicToolChoice({ hasTools: true, toolChoice: 'none', thinkingEnabled: true })).toEqual({ type: 'none' })
    expect(buildAnthropicToolChoice({ hasTools: true, toolChoice: { name: 'post_to_facebook' }, thinkingEnabled: false }))
      .toEqual({ type: 'tool', name: 'post_to_facebook', disable_parallel_tool_use: undefined })
    expect(buildAnthropicToolChoice({ hasTools: true, toolChoice: 'required', thinkingEnabled: false }))
      .toEqual({ type: 'any', disable_parallel_tool_use: undefined })
    // thinking on → forced call downgrades to auto (sequential when asked)
    expect(buildAnthropicToolChoice({
      hasTools: true, toolChoice: { name: 'post_to_facebook' }, parallelToolCalls: false, thinkingEnabled: true,
    })).toEqual({ type: 'auto', disable_parallel_tool_use: true })
    expect(buildAnthropicToolChoice({ hasTools: true, parallelToolCalls: false, thinkingEnabled: true }))
      .toEqual({ type: 'auto', disable_parallel_tool_use: true })
  })
})

describe('neutral capToolResult (Phase 6 vision fix)', () => {
  it('preserves the image object while capping oversized textual rest', () => {
    const bigText = 'x'.repeat(20_000)
    const msgs = appendToolExchange(
      [],
      [{ id: 't1', name: 'live_browser_look', input: {} }],
      [{ id: 't1', name: 'live_browser_look', result: { success: true, data: { text: bigText }, image: { data: 'IMG'.repeat(10_000), mediaType: 'image/jpeg' } } }],
    )
    const toolMsg = msgs[1] as { role: 'tool'; result: Record<string, unknown> }
    expect(toolMsg.role).toBe('tool')
    // image survives untouched…
    expect((toolMsg.result.image as { data: string }).data.length).toBe(30_000)
    // …while the textual payload got capped.
    const textual = JSON.stringify({ ...toolMsg.result, image: undefined })
    expect(textual.length).toBeLessThan(14_000)
    expect(textual).toContain('truncated')
  })

  it('small results with images pass through unchanged', () => {
    const msgs = appendToolExchange(
      [],
      [{ id: 't1', name: 'live_browser_look', input: {} }],
      [{ id: 't1', name: 'live_browser_look', result: { success: true, data: { url: 'https://x.com' }, image: { data: 'SMALL', mediaType: 'image/png' } } }],
    )
    const toolMsg = msgs[1] as { role: 'tool'; result: Record<string, unknown> }
    expect(toolMsg.result.data).toEqual({ url: 'https://x.com' })
    expect((toolMsg.result.image as { data: string }).data).toBe('SMALL')
  })
})
