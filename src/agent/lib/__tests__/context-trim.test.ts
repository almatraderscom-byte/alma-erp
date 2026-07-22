import { describe, it, expect, afterEach } from 'vitest'
import {
  trimToolResultForHistory,
  TRIM_THRESHOLD_CHARS,
  TRIM_HEAD_CHARS,
  TRIM_TAIL_CHARS,
} from '../context-trim'

describe('context trim (harness gap 4)', () => {
  afterEach(() => { delete process.env.AGENT_TOOLRESULT_TRIM })

  it('passes short results through untouched', () => {
    const s = 'x'.repeat(TRIM_THRESHOLD_CHARS)
    expect(trimToolResultForHistory(s)).toBe(s)
  })

  it('trims oversized results keeping head + tail with a marker', () => {
    const s = `HEAD${'m'.repeat(10_000)}TAIL`
    const out = trimToolResultForHistory(s)
    expect(out.length).toBeLessThan(TRIM_HEAD_CHARS + TRIM_TAIL_CHARS + 200)
    expect(out.startsWith('HEAD')).toBe(true)
    expect(out.endsWith('TAIL')).toBe(true)
    expect(out).toContain('ছেঁটে ফেলা হয়েছে')
  })

  it('is deterministic — same input, same bytes (prompt-cache safety)', () => {
    const s = 'q'.repeat(9000)
    expect(trimToolResultForHistory(s)).toBe(trimToolResultForHistory(s))
  })

  it('kill switch AGENT_TOOLRESULT_TRIM=false passes everything through', () => {
    process.env.AGENT_TOOLRESULT_TRIM = 'false'
    const s = 'y'.repeat(20_000)
    expect(trimToolResultForHistory(s)).toBe(s)
  })
})
