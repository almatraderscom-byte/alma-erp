import { describe, expect, it } from 'vitest'
import { compactTimelineForStorage, compactTimelineWithIndexMap } from '../timeline-compaction'
import { ProseLifecycleTracker } from '../prose-lifecycle'
import { buildAgentPresentationV2 } from '../build-presentation-v2'
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

describe('compaction keeps prose anchors pointing at the stored entries (Codex P1 #838)', () => {
  it('remaps every kept index and marks dropped entries', () => {
    const tl = Array.from({ length: 10 }, (_, i) => (i % 3 === 0 ? { t: 'text', text: `p${i}` } : { t: 'think', text: `t${i}` }))
    const { timeline, indexMap } = compactTimelineWithIndexMap(tl, 6)
    expect(timeline.length).toBeLessThanOrEqual(6)
    indexMap.forEach((newIndex, oldIndex) => {
      if (newIndex >= 0) expect(timeline[newIndex]).toEqual(tl[oldIndex])
      else expect(tl[oldIndex].t).toBe('think')
    })
    expect(tl.filter((e) => e.t === 'text').every((e, i) => timeline.filter((x) => x.t === 'text')[i] === e)).toBe(true)
  })

  it('a block anchored after a long tool run still renders beside its own tool after compaction', () => {
    const tracker = new ProseLifecycleTracker({ protocol: 2, turnId: 'turn-cap' })
    const timeline: Array<Record<string, unknown>> = []
    const pushText = (text: string) => { tracker.anchorTimeline(timeline.length); timeline.push({ t: 'text', text }) }
    tracker.process({ type: 'text_delta', delta: 'লিড' }); pushText('লিড'); tracker.process({ type: 'preamble', text: 'লিড' })
    for (let i = 0; i < 70; i++) {
      timeline.push({ t: 'think', text: `think ${i}` })
      tracker.process({ type: 'tool_start', id: `t${i}`, name: `tool_${i}` })
      timeline.push({ t: 'tool', name: `tool_${i}`, ok: true })
      tracker.process({ type: 'tool_end', id: `t${i}`, name: `tool_${i}`, success: true })
    }
    tracker.process({ type: 'progress_update', label: 'r', stage: 'round' })
    tracker.process({ type: 'text_delta', delta: 'শেষ ধাপের আপডেট' }); pushText('শেষ ধাপের আপডেট')
    tracker.process({ type: 'tool_start', id: 'last', name: 'final_tool' })
    timeline.push({ t: 'tool', name: 'final_tool', ok: true })
    tracker.process({ type: 'tool_end', id: 'last', name: 'final_tool', success: true })
    tracker.process({ type: 'text_delta', delta: 'ফাইনাল' }); pushText('ফাইনাল')

    const stored = compactTimelineWithIndexMap(timeline, 60)
    const doc = tracker.document('m', { remapTimelineIndex: (i) => stored.indexMap[i] })
    const p = buildAgentPresentationV2({ messageId: 'm', timeline: stored.timeline, document: doc })
    const seq = p.blocks.map((b) => (b.type === 'prose' ? `prose:${b.text}` : `${(b as { activityType: string }).activityType}:${(b as { label: string }).label}`))
    // The late update sits right before its own tool, the final after it.
    const update = seq.indexOf('prose:শেষ ধাপের আপডেট')
    expect(seq[update + 1]).toBe('tool:final_tool')
    expect(seq[update + 2]).toBe('prose:ফাইনাল')
    expect(seq[0]).toBe('prose:লিড')
    // Without the remap the stale anchors would land the update far earlier.
    const stale = buildAgentPresentationV2({ messageId: 'm', timeline: stored.timeline, document: tracker.document('m') })
    const staleSeq = stale.blocks.map((b) => (b.type === 'prose' ? `prose:${b.text}` : 'activity'))
    expect(staleSeq.indexOf('prose:শেষ ধাপের আপডেট')).not.toBe(update)
  })
})
