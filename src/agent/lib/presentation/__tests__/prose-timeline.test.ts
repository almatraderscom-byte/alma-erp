import { describe, expect, it } from 'vitest'
import fixture from '@/agent/protocol/fixtures/prose-lifecycle-v2/golden-lead-progress-final.json'
import { ProseLifecycleTracker, type WireEvent } from '../prose-lifecycle'
import { applyProseEvent, createLiveProseState, type LiveProseState } from '../live-prose-reducer'
import { buildAgentPresentationV2 } from '../build-presentation-v2'
import {
  proseBlocksFromPresentationV2,
  proseTextFromPresentationV2,
  reconcileProseTimeline,
  timelineFromPresentationV2,
  type ProseTimelineEntry,
} from '../prose-timeline'

type Step = { timeline?: Record<string, unknown>; emit?: WireEvent; save?: boolean }
const fx = fixture as unknown as { turnId: string; messageId: string; script: Step[]; expectedOwnerVisibleText: string; expectedPresentationV2: { sequence: string[] } }

/**
 * The web keeps prose ↔ activity in ONE ordered timeline. These lock the two
 * bridges: live (reducer state → placeholders in place) and cold (server v2
 * blocks → the same timeline shape), and that both describe the same owner
 * transcript as the server's own projection.
 */
describe('prose-timeline — live placeholders', () => {
  it('keeps a committed progress block in place across later tools and a verifier swap', () => {
    const tracker = new ProseLifecycleTracker({ protocol: 2, turnId: fx.turnId })
    let state: LiveProseState = createLiveProseState()
    let timeline: ProseTimelineEntry[] = []
    for (const step of fx.script) {
      if (step.timeline) {
        if (step.timeline.t === 'text') tracker.anchorTimeline(timeline.length)
        // The web mirrors activity entries from the wire; the fixture timeline
        // stands in for those pushes here.
        if (step.timeline.t !== 'text') timeline = [...timeline, step.timeline as ProseTimelineEntry]
      }
      if (step.emit) {
        for (const out of tracker.process(step.emit)) {
          const next = applyProseEvent(state, out)
          if (next !== state) {
            state = next
            timeline = reconcileProseTimeline(timeline, state)
          }
        }
      }
    }
    const rendered = timeline.map((e) => (e.t === 'text' ? `text:${e.kind}:${e.blockId}` : e.t))
    expect(rendered).toEqual([
      'think',
      'text:lead:turn-fx-1:p1',
      'text:progress:turn-fx-1:p2',
      'think',
      'tool',
      'think',
      'tool',
      'text:progress:turn-fx-1:p3',
      'verify',
      // the verified replacement appears AFTER the verify row, where the
      // superseded draft's placeholder was dropped — same order as the cold view
      'text:final:turn-fx-1:p5',
    ])
    expect(timeline.filter((e) => e.t === 'text').map((e) => (e as { text: string }).text).join('\n\n'))
      .toBe(fx.expectedOwnerVisibleText)
  })

  it('a replacement of a hidden intermediate retires the whole chain and lands at the current end', () => {
    let s = createLiveProseState()
    let tl: ProseTimelineEntry[] = []
    const apply = (e: WireEvent) => { s = applyProseEvent(s, e); tl = reconcileProseTimeline(tl, s) }
    apply({ type: 'prose_start', blockId: 'x', kind: 'draft', revision: 1 })
    apply({ type: 'text_delta', blockId: 'x', delta: 'X', revision: 1 })
    tl = [...tl, { t: 'tool', name: 'a', ok: true }]
    apply({ type: 'prose_supersede', blockId: 'x', replacementBlockId: 'y', reason: 'r1' })
    apply({ type: 'prose_start', blockId: 'y', kind: 'draft', revision: 1, replaces: 'x' })
    apply({ type: 'text_delta', blockId: 'y', delta: 'Y', revision: 1 })
    apply({ type: 'prose_supersede', blockId: 'y', replacementBlockId: 'z', reason: 'r2' })
    apply({ type: 'prose_start', blockId: 'z', kind: 'draft', revision: 1, replaces: 'y' })
    apply({ type: 'text_delta', blockId: 'z', delta: 'Z', revision: 1 })
    expect(tl.map((e) => (e.t === 'text' ? `${e.blockId}:${e.text}` : e.t))).toEqual(['x:X', 'tool'])
    apply({ type: 'prose_commit', blockId: 'z', kind: 'final', revision: 1, text: 'Z' })
    expect(tl.map((e) => (e.t === 'text' ? `${e.blockId}:${e.text}` : e.t))).toEqual(['tool', 'z:Z'])
    expect(s.blocks.map((b) => b.id)).toEqual(['z'])
  })
})

describe('prose-timeline — cold load from presentation v2', () => {
  it('converts the server projection into the live timeline shape, same transcript', () => {
    const tracker = new ProseLifecycleTracker({ protocol: 2, turnId: fx.turnId })
    const rawTimeline: Array<Record<string, unknown>> = []
    let doc: ReturnType<typeof tracker.document> | null = null
    for (const step of fx.script) {
      if (step.timeline) {
        if (step.timeline.t === 'text') tracker.anchorTimeline(rawTimeline.length)
        rawTimeline.push(step.timeline)
      }
      if (step.save) doc = tracker.document(fx.messageId)
      if (step.emit) tracker.process(step.emit)
    }
    const v2 = buildAgentPresentationV2({ messageId: fx.messageId, timeline: rawTimeline, document: doc! })
    const cold = timelineFromPresentationV2(v2.blocks)
    expect(cold.map((e) => (e.t === 'text' ? `text:${e.kind}:${e.blockId}` : e.t))).toEqual([
      'think',
      'text:lead:turn-fx-1:p1',
      'think',
      'text:progress:turn-fx-1:p2',
      'tool',
      'think',
      'tool',
      'text:progress:turn-fx-1:p3',
      'verify',
      'text:final:turn-fx-1:p5',
    ])
    const verify = cold.find((e) => e.t === 'verify') as { attempt?: number; max?: number }
    expect(verify).toMatchObject({ attempt: 1, max: 2 })
    expect(proseTextFromPresentationV2(v2.blocks)).toBe(fx.expectedOwnerVisibleText)
    expect(proseBlocksFromPresentationV2(v2.blocks).map((b) => `${b.kind}:${b.id}`)).toEqual([
      'lead:turn-fx-1:p1',
      'progress:turn-fx-1:p2',
      'progress:turn-fx-1:p3',
      'final:turn-fx-1:p5',
    ])
  })
})
