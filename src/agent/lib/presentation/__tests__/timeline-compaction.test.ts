import { describe, expect, it } from 'vitest'
import { compactTimelineForStorage } from '../timeline-compaction'
import { selectSettledProse } from '../build-presentation'

/**
 * Handoff F-14: the stored timeline must never lose owner prose, verify rows or
 * files to the 60-entry cap; activity is what gets compacted.
 */
describe('compactTimelineForStorage', () => {
  const turn = (rounds: number) => {
    const out: Array<Record<string, unknown>> = [{ t: 'text', text: 'লিড', lead: true }]
    for (let r = 0; r < rounds; r++) {
      out.push({ t: 'think', text: `think ${r}` })
      if (r % 2 === 1) out.push({ t: 'text', text: `progress ${r}` })
      out.push({ t: 'tool', name: `tool_${r}`, ok: true })
    }
    out.push({ t: 'text', text: 'ড্রাফট', state: 'superseded' })
    out.push({ t: 'verify', attempt: 1, max: 2 })
    out.push({ t: 'text', text: 'FINAL' })
    return out
  }

  it('returns the timeline untouched when it fits', () => {
    const tl = turn(5)
    expect(compactTimelineForStorage(tl, 60)).toEqual(tl)
  })

  it('keeps every prose / verify / file entry and the terminal block beyond the cap', () => {
    const tl = turn(40)   // 1 + 40*2 + 20 + 3 = 104 entries
    const out = compactTimelineForStorage(tl, 60)
    expect(out.length).toBeLessThanOrEqual(60)
    const kinds = (arr: Array<Record<string, unknown>>) => arr.filter((e) => e.t === 'text' || e.t === 'verify' || e.t === 'file')
    expect(kinds(out)).toEqual(kinds(tl))
    expect(out.at(-1)).toEqual({ t: 'text', text: 'FINAL' })
    // Thinking rows go first; tool rows only when still over the cap.
    expect(out.filter((e) => e.t === 'think').length).toBeLessThan(tl.filter((e) => e.t === 'think').length)
    // Relative order is preserved.
    const names = out.filter((e) => e.t === 'tool').map((e) => e.name)
    expect(names).toEqual([...names].sort((a, b) => Number(String(a).slice(5)) - Number(String(b).slice(5))))
  })

  it('the legacy settled-prose selection still finds the real final after compaction', () => {
    const tl = turn(40)
    const content = [{ type: 'text', text: 'লিড\n\n' + tl.filter((e) => e.t === 'text' && e.state !== 'superseded').map((e) => e.text).join('\n\n') }]
    expect(selectSettledProse(content, compactTimelineForStorage(tl, 60))).toBe('FINAL')
    // …whereas the old slice(0, 60) cut the final off.
    expect(selectSettledProse(content, tl.slice(0, 60))).not.toBe('FINAL')
  })

  it('when prose alone exceeds the cap, the most recent entries win (terminal kept)', () => {
    const tl = Array.from({ length: 80 }, (_, i) => ({ t: 'text', text: `p${i}` }))
    const out = compactTimelineForStorage(tl, 60)
    expect(out).toHaveLength(60)
    expect(out[0]).toEqual({ t: 'text', text: 'p20' })
    expect(out.at(-1)).toEqual({ t: 'text', text: 'p79' })
  })
})
