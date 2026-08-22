import { describe, expect, it } from 'vitest'
import {
  ProseLifecycleTracker,
  negotiateProseProtocol,
  projectEventForProtocol,
  proseProtocolFromVersions,
  type WireEvent,
} from '../prose-lifecycle'
import {
  applyProseEvent,
  createLiveProseState,
  visibleProseBlocks,
  type LiveProseState,
} from '../live-prose-reducer'

const T = 'turn-edge'
const text = (delta: string): WireEvent => ({ type: 'text_delta', delta })
const tool = (id: string): WireEvent => ({ type: 'tool_start', id, name: 'x' })
const toolEnd = (id: string): WireEvent => ({ type: 'tool_end', id, name: 'x', success: true })
const round = (n: number): WireEvent => ({ type: 'progress_update', label: `ধাপ ${n}`, stage: 'round' })
const retry = (categories: string[] = []): WireEvent => ({ type: 'verification_retry', attempt: 1, maxAttempts: 2, categories, snippets: [] })
const done: WireEvent = { type: 'done', messageId: 'm' }

function drive(events: WireEvent[], protocol: 1 | 2 = 2) {
  const tracker = new ProseLifecycleTracker({ protocol, turnId: T })
  const out: WireEvent[] = []
  let reducer: LiveProseState = createLiveProseState()
  for (const e of events) {
    const o = tracker.process(e)
    out.push(...o)
    for (const x of o) reducer = applyProseEvent(reducer, x)
  }
  return { tracker, out, reducer, visible: visibleProseBlocks(reducer).map((b) => `${b.kind}:${b.text}`) }
}

describe('tracker edge cases', () => {
  it('tool_start never touches committed prose; tool_end ends the continuation window', () => {
    const r = drive([text('P1'), tool('a'), text(' tail'), tool('a'), toolEnd('a'), text('P2'), tool('b')])
    expect(r.visible).toEqual(['progress:P1 tail', 'progress:P2'])
    expect(r.tracker.visibleBlocks().map((b) => b.id)).toEqual([`${T}:p1`, `${T}:p2`])
  })

  it('media hard gate retires the spoken lead too, replacement pending on the last block', () => {
    const r = drive([text('লিড'), { type: 'preamble', text: 'লিড' }, text('\n\nচলছে'), retry(['media_playback_unverified'])])
    const supersedes = r.out.filter((e) => e.type === 'prose_supersede')
    expect(supersedes.map((e) => [e.blockId, Boolean(e.replacementBlockId)])).toEqual([[`${T}:p1`, false], [`${T}:p2`, true]])
    // The lead is gone at once; the draft stays until its replacement commits.
    expect(r.visible).toEqual(['draft:চলছে'])
  })

  it('prospective_plan_start supersedes every visible block explicitly, then fresh prose starts clean', () => {
    const r = drive([text('লিড'), { type: 'preamble', text: 'লিড' }, text('\n\nখসড়া'), { type: 'prospective_plan_start' }, text('প্ল্যানের পরে'), done])
    const types = r.out.map((e) => e.type)
    expect(types.filter((t) => t === 'prose_supersede')).toHaveLength(2)
    expect(types.indexOf('prospective_plan_start')).toBeGreaterThan(types.lastIndexOf('prose_supersede'))
    expect(r.visible).toEqual(['final:প্ল্যানের পরে'])
  })

  it('a second retry before the replacement opened keeps ONE pending promise', () => {
    const r = drive([text('খসড়া'), retry(['a']), retry(['b']), text('ঠিক'), done])
    expect(r.out.filter((e) => e.type === 'prose_supersede')).toHaveLength(1)
    expect(r.visible).toEqual(['final:ঠিক'])
  })

  it('a retry whose replacement never arrives removes the draft at settlement', () => {
    const r = drive([text('খসড়া'), retry(['claim']), done])
    const sup = r.out.filter((e) => e.type === 'prose_supersede')
    expect(sup.map((e) => e.reason)).toEqual(['claim', 'no_replacement'])
    expect(r.visible).toEqual([])
    expect(r.tracker.document('m').blocks.map((b) => b.state)).toEqual(['superseded'])
  })

  it('the stable answer stays visible across the rewrite round and swaps atomically on commit', () => {
    const r1 = drive([text('পুরোনো'), retry(['x']), round(2), text('নতুন')])
    expect(r1.visible).toEqual(['draft:পুরোনো'])
    const r2 = drive([text('পুরোনো'), retry(['x']), round(2), text('নতুন'), done])
    expect(r2.visible).toEqual(['final:নতুন'])
    expect(r2.reducer.blocks.map((b) => b.id)).toEqual([`${T}:p2`])
  })

  it('a block opened by a separator-only delta is retired instead of lingering empty', () => {
    const r = drive([text('\n\n'), tool('a')])
    const types = r.out.map((e) => e.type)
    expect(types).toEqual(['prose_start', 'prose_supersede', 'tool_start'])
    expect(r.reducer.blocks).toHaveLength(0)
  })

  it('the last committed progress is relabelled final at settlement (ask-card shape)', () => {
    const r = drive([text('উত্তর'), tool('ask'), { type: 'ask_card', askCardId: 'q', question: '?', options: [] }, toolEnd('ask'), done])
    const commits = r.out.filter((e) => e.type === 'prose_commit').map((e) => [e.kind, e.revision])
    expect(commits).toEqual([['progress', 1], ['final', 2]])
    expect(r.visible).toEqual(['final:উত্তর'])
  })

  it('a lone lead stays a lead (never relabelled final)', () => {
    const r = drive([text('লিড'), { type: 'preamble', text: 'লিড' }, done])
    expect(r.visible).toEqual(['lead:লিড'])
    expect(r.tracker.document('m').blocks[0].kind).toBe('lead')
  })

  it('the forced update and the next round narration never merge into one block', () => {
    const r = drive([round(3), text('আপডেট'), round(4), text('\n\nপরের কাজ'), tool('c'), done])
    expect(r.visible).toEqual(['progress:আপডেট', 'final:পরের কাজ'])
  })

  it('timeline anchors: open block first, then reserved for the next block', () => {
    const tracker = new ProseLifecycleTracker({ protocol: 2, turnId: T })
    tracker.process(text('লিড'))
    tracker.anchorTimeline(1)      // lead entry pushed while the block is open
    tracker.process({ type: 'preamble', text: 'লিড' })
    tracker.anchorTimeline(4)      // harness line pushed BEFORE its delta streams
    tracker.process(text('হারনেস লাইন'))
    tracker.process(done)
    expect(tracker.document('m').blocks.map((b) => b.timelineIndex)).toEqual([1, 4])
  })

  it('tracker failures degrade to pass-through instead of killing the turn', () => {
    const tracker = new ProseLifecycleTracker({ protocol: 2, turnId: T })
    // Force an internal failure by feeding a poisoned event object.
    const poisoned = Object.create(null) as WireEvent
    Object.defineProperty(poisoned, 'type', { get: () => 'text_delta' })
    Object.defineProperty(poisoned, 'delta', { get: () => { throw new Error('boom') } })
    expect(tracker.process(poisoned)).toEqual([poisoned])
    expect(tracker.process(text('পরে'))).toEqual([text('পরে')])   // broken → pass-through
  })
})

describe('reducer edge cases', () => {
  it('self-heals a block whose delta was lost, from the commit text', () => {
    let s = createLiveProseState()
    s = applyProseEvent(s, { type: 'prose_start', blockId: 'b1', kind: 'draft', revision: 1 })
    s = applyProseEvent(s, { type: 'text_delta', delta: 'আংশিক', blockId: 'b1', revision: 1 })
    s = applyProseEvent(s, { type: 'prose_commit', blockId: 'b1', kind: 'progress', revision: 1, text: 'আংশিক পূর্ণ' })
    expect(visibleProseBlocks(s).map((b) => b.text)).toEqual(['আংশিক পূর্ণ'])
  })

  it('a delta before its prose_start (replay edge) still creates the block', () => {
    let s = createLiveProseState()
    s = applyProseEvent(s, { type: 'text_delta', delta: 'হঠাৎ', blockId: 'b9', revision: 1 })
    expect(visibleProseBlocks(s).map((b) => b.id)).toEqual(['b9'])
  })

  it('v1 deltas (no blockId) are ignored by the v2 reducer — never inferred', () => {
    const s = applyProseEvent(createLiveProseState(), { type: 'text_delta', delta: 'anonymous' })
    expect(s.blocks).toHaveLength(0)
  })

  it('tool_start / verification_retry / prospective_plan_start are no-ops for v2 prose', () => {
    let s = createLiveProseState()
    s = applyProseEvent(s, { type: 'prose_start', blockId: 'b1', kind: 'draft', revision: 1 })
    s = applyProseEvent(s, { type: 'text_delta', delta: 'থাকবে', blockId: 'b1', revision: 1 })
    const before = s
    expect(applyProseEvent(s, { type: 'tool_start', id: 't', name: 'x' })).toBe(before)
    expect(applyProseEvent(s, { type: 'verification_retry', attempt: 1, maxAttempts: 1 })).toBe(before)
    expect(applyProseEvent(s, { type: 'prospective_plan_start' })).toBe(before)
  })
})

describe('negotiation + mixed-version projection', () => {
  const env = { AGENT_PROSE_PROTOCOL_V2: undefined, AGENT_NATIVE_ANTHROPIC_LOOP: undefined }
  it('only an explicit client request gets v2; voice, native loop and the kill switch force v1', () => {
    expect(negotiateProseProtocol({ requested: undefined, env })).toBe(1)
    expect(negotiateProseProtocol({ requested: '2', env })).toBe(2)
    expect(negotiateProseProtocol({ requested: 2, env })).toBe(2)
    expect(negotiateProseProtocol({ requested: 3, env })).toBe(2)
    expect(negotiateProseProtocol({ requested: 2, voiceTurn: true, env })).toBe(1)
    expect(negotiateProseProtocol({ requested: 2, env: { ...env, AGENT_NATIVE_ANTHROPIC_LOOP: 'true' } })).toBe(1)
    expect(negotiateProseProtocol({ requested: 2, env: { ...env, AGENT_PROSE_PROTOCOL_V2: 'off' } })).toBe(1)
    expect(proseProtocolFromVersions({ agentProseProtocol: 2 })).toBe(2)
    expect(proseProtocolFromVersions({ prompt: 'x' })).toBe(1)
    expect(proseProtocolFromVersions(null)).toBe(1)
  })

  it('projects v2 events to the v1 family for a v1 client and leaves v2 clients untouched', () => {
    const ev: WireEvent = { type: 'text_delta', delta: 'x', blockId: 'b', revision: 1 }
    expect(projectEventForProtocol(ev, 2)).toBe(ev)
    expect(projectEventForProtocol(ev, 1)).toEqual({ type: 'text_delta', delta: 'x' })
    expect(projectEventForProtocol({ type: 'prose_commit', blockId: 'b', kind: 'final', revision: 1, text: 'x' }, 1)).toBeNull()
    expect(projectEventForProtocol({ type: 'turn_protocol', agentProseProtocol: 2 }, 1)).toBeNull()
    expect(projectEventForProtocol({ type: 'prose_supersede', blockId: 'b', reason: 'rewrite' }, 1))
      .toEqual({ type: 'verification_retry', attempt: 1, maxAttempts: 1, categories: [], snippets: [] })
    expect(projectEventForProtocol({ type: 'done', messageId: 'm' }, 1)).toEqual({ type: 'done', messageId: 'm' })
  })
})
