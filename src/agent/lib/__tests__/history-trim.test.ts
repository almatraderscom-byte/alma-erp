/**
 * Size-based history trimming (owner cost analysis 2026-07-26).
 *
 * His meter, his reading: ~300k tokens re-sent per turn at $0.17 each, because
 * "keep the last 6 turns" is meaningless when one tool result is a whole audit
 * JSON. "প্রতিটা পেজের SEO করতে তো পুরো website বারবার লিখতে হয় না।"
 */
import { describe, expect, it } from 'vitest'
import {
  KEEP_VERBATIM_MESSAGES,
  TRIM_THRESHOLD_CHARS,
  estimateChars,
  trimHistoryBySize,
  trimText,
} from '@/agent/lib/history-trim'

const big = (n: number) => 'x'.repeat(n)
const msg = (content: unknown, role = 'assistant') => ({ role, content })

describe('trimText', () => {
  it('leaves ordinary text alone', () => {
    expect(trimText('ছোট উত্তর')).toBe('ছোট উত্তর')
    expect(trimText(big(TRIM_THRESHOLD_CHARS))).toHaveLength(TRIM_THRESHOLD_CHARS)
  })

  it('keeps the head and tail of a whale, and says how much it cut', () => {
    const out = trimText(big(200_000))
    expect(out.length).toBeLessThan(3_000)
    expect(out).toContain('অক্ষর সংক্ষেপ করা হয়েছে')
    expect(out.startsWith('xxx')).toBe(true)
    expect(out.endsWith('xxx')).toBe(true)
  })
})

describe('trimHistoryBySize', () => {
  it('never touches the newest messages — the model needs those in full', () => {
    const rows = [
      msg(big(50_000)), msg(big(50_000)), msg(big(50_000)),
      msg(big(50_000)), msg(big(50_000)), msg(big(50_000)),
    ]
    const out = trimHistoryBySize(rows)
    const kept = out.slice(-KEEP_VERBATIM_MESSAGES)
    for (const k of kept) expect(String(k.content)).toHaveLength(50_000)
  })

  it('collapses the older whales — the actual saving', () => {
    const rows = Array.from({ length: 10 }, () => msg(big(50_000)))
    const before = estimateChars(rows)
    const after = estimateChars(trimHistoryBySize(rows))

    expect(before).toBe(500_000)
    // six older 50k blocks collapse to ~1.6k each; the four newest stay whole.
    expect(after).toBeLessThan(220_000)
  })

  it('trims a tool-result block, which is where the audit JSON actually lives', () => {
    const rows = [
      msg([{ type: 'tool_result', tool_use_id: 't1', content: big(120_000) }]),
      msg('short 1'), msg('short 2'), msg('short 3'), msg('short 4'),
    ]
    const out = trimHistoryBySize(rows)
    const block = (out[0].content as Array<Record<string, unknown>>)[0]
    expect(String(block.content).length).toBeLessThan(3_000)
    expect(String(block.content)).toContain('সংক্ষেপ')
  })

  it('leaves a short conversation completely alone', () => {
    const rows = [msg('hi'), msg('hello')]
    expect(trimHistoryBySize(rows)).toEqual(rows)
  })

  it('does not disturb non-text blocks (images, file refs)', () => {
    const rows = [
      msg([{ type: 'file_ref', bucket: 'b', path: 'p', mediaType: 'image/png' }]),
      msg('a'), msg('b'), msg('c'), msg('d'),
    ]
    expect(trimHistoryBySize(rows)[0]).toEqual(rows[0])
  })
})

// Owner ruling 2026-07-26: a resumed hop starts from its checkpoint, not by
// re-reading the whole thread — "তুমি নিজেও তো এভাবে কাজ করো না"।
describe('a self-continue hop replays almost nothing', () => {
  it('recognises the resume directive as the newest user message', async () => {
    const { lastUserTextPeek } = await import('@/agent/lib/history-trim')
    const rows = [
      msg('পুরনো কথা', 'user'),
      msg('উত্তর'),
      msg([{ type: 'text', text: '[SELF-CONTINUE — hop 2] কাজ শেষ হয়নি' }], 'user'),
    ]
    expect(lastUserTextPeek(rows)).toContain('SELF-CONTINUE')
  })

  it('ignores an ASSISTANT message that merely quotes the marker', async () => {
    const { lastUserTextPeek } = await import('@/agent/lib/history-trim')
    const rows = [msg('আসল প্রশ্ন', 'user'), msg('[SELF-CONTINUE — hop 2] …')]
    expect(lastUserTextPeek(rows)).toBe('আসল প্রশ্ন')
  })
})
