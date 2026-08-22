import { describe, expect, it } from 'vitest'
import fixture from '@/agent/protocol/fixtures/prose-lifecycle-v2/golden-lead-progress-final.json'
import {
  ProseLifecycleTracker,
  fnv1aHex,
  projectEventForProtocol,
  proseFingerprint,
  readPresentationV2Document,
  visibleDocumentBlocks,
  type PresentationV2Document,
  type WireEvent,
} from '../prose-lifecycle'
import {
  applyProseEvent,
  createLiveProseState,
  liveProseFingerprint,
  visibleProseBlocks,
  visibleProseText,
  type LiveProseState,
} from '../live-prose-reducer'
import { buildAgentPresentationV2, presentationV1FromV2 } from '../build-presentation-v2'

/**
 * Handoff Phase 0 — the cross-layer golden fixture. One JSON transcript drives:
 *   - the server tracker (v2 wire derivation + the authoritative document),
 *   - the pure client reducer (the web; the Swift reducer replays the same
 *     file from the test bundle — see the drift test),
 *   - the settled GET projection (v2 + derived v1),
 *   - the mixed-version projection an old client receives.
 * Every checkpoint in the handoff's acceptance matrix is an assertion here.
 */

type Step = {
  timeline?: Record<string, unknown>
  emit?: WireEvent
  /** The v2 wire the tracker must produce for THIS input step (native test replays these). */
  v2?: WireEvent[]
  save?: boolean
  visible?: Array<{ id: string; kind: string; text: string }>
  note?: string
}

type Fixture = {
  turnId: string
  messageId: string
  script: Step[]
  expectedV2Events: WireEvent[]
  expectedDocument: Omit<PresentationV2Document, 'fingerprint'>
  expectedPresentationV2: { sequence: string[]; selfCorrected: boolean }
  expectedV1Projection: { proseStates: string[]; legacyIosVisibleTexts: string[] }
  expectedOldClientEventTypes: string[]
  expectedOwnerVisibleText: string
  expectedFinalVisible: Array<{ id: string; kind: string; text: string }>
}

const fx = fixture as unknown as Fixture

function runScript(protocol: 1 | 2) {
  const tracker = new ProseLifecycleTracker({ protocol, turnId: fx.turnId })
  const timeline: Array<Record<string, unknown>> = []
  const input: WireEvent[] = []
  const output: WireEvent[] = []
  let reducer: LiveProseState = createLiveProseState()
  let document: PresentationV2Document | null = null
  const checkpoints: Array<{ step: number; tracker: unknown; reducer: unknown; expected: unknown }> = []

  fx.script.forEach((step, index) => {
    if (step.timeline) {
      // Mirrors the runner's `pushTextEntry`: anchor first, then push.
      if (step.timeline.t === 'text') tracker.anchorTimeline(timeline.length)
      timeline.push(step.timeline)
    }
    if (step.save) document = tracker.document(fx.messageId)
    if (step.emit) {
      input.push(step.emit)
      const out = tracker.process(step.emit)
      if (protocol === 2 && step.v2) {
        const stripped = out.map((e) => {
          if (e.type !== 'prose_commit') return e
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { checksum, ...rest } = e
          return rest
        })
        if (JSON.stringify(stripped) !== JSON.stringify(step.v2)) {
          throw new Error(`step ${index}: v2 output ${JSON.stringify(stripped)} != fixture ${JSON.stringify(step.v2)}`)
        }
      }
      output.push(...out)
      for (const ev of out) reducer = applyProseEvent(reducer, ev)
      if (step.visible) {
        checkpoints.push({
          step: index,
          tracker: tracker.visibleBlocks(),
          reducer: visibleProseBlocks(reducer).map((b) => ({ id: b.id, kind: b.kind, text: b.text })),
          expected: step.visible,
        })
      }
    }
  })
  return { tracker, timeline, input, output, reducer, document: document as PresentationV2Document | null, checkpoints }
}

describe('prose lifecycle v2 — golden fixture (server tracker + web reducer)', () => {
  const run = runScript(2)

  it('the tracker and the reducer agree with the fixture after every checkpoint', () => {
    expect(run.checkpoints.length).toBeGreaterThan(5)
    for (const c of run.checkpoints) {
      expect(c.tracker, `tracker visible at step ${c.step}`).toEqual(c.expected)
      expect(c.reducer, `reducer visible at step ${c.step}`).toEqual(c.expected)
    }
  })

  it('emits exactly the typed v2 event family (no verification_retry, stable ids)', () => {
    const stripChecksum = (e: WireEvent) => {
      if (e.type !== 'prose_commit') return e
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { checksum, ...rest } = e
      expect(checksum).toBe(fnv1aHex(String(e.text)))
      return rest
    }
    expect(run.output.map(stripChecksum)).toEqual(fx.expectedV2Events)
    expect(run.output.some((e) => e.type === 'verification_retry')).toBe(false)
  })

  it('writes the authoritative document with every committed block, the superseded draft and anchors', () => {
    expect(run.document).not.toBeNull()
    const doc = run.document!
    expect({ ...doc, fingerprint: undefined }).toEqual({ ...fx.expectedDocument, fingerprint: undefined })
    expect(doc.fingerprint).toBe(proseFingerprint(visibleDocumentBlocks(doc.blocks)))
    // Round-trips through the usage JSON reader unchanged.
    expect(readPresentationV2Document({ presentationV2: JSON.parse(JSON.stringify(doc)) })).toEqual(doc)
  })

  it('live → done → persisted fingerprints are identical (parity invariant)', () => {
    const doc = run.document!
    expect(liveProseFingerprint(run.reducer)).toBe(doc.fingerprint)
    expect(proseFingerprint(run.tracker.visibleBlocks())).toBe(doc.fingerprint)
    expect(visibleProseBlocks(run.reducer).map((b) => ({ id: b.id, kind: b.kind, text: b.text })))
      .toEqual(fx.expectedFinalVisible)
    expect(visibleProseText(run.reducer)).toBe(fx.expectedOwnerVisibleText)
    expect(run.tracker.ownerVisibleText()).toBe(fx.expectedOwnerVisibleText)
  })

  it('GET projection v2 keeps every committed block in chronology, superseded hidden', () => {
    const doc = run.document!
    const p = buildAgentPresentationV2({
      messageId: fx.messageId,
      content: [{ type: 'text', text: 'irrelevant accumulated text' }],
      timeline: run.timeline,
      document: doc,
      tokensIn: 10,
      tokensOut: 5,
    })
    expect(p.version).toBe(2)
    expect(p.protocol).toBe(2)
    expect(p.blocks.map((b) => (b.type === 'prose' ? `prose:${b.kind}:${b.id}` : `activity:${(b as { activityType: string }).activityType}`)))
      .toEqual(fx.expectedPresentationV2.sequence)
    expect(p.selfCorrected).toBe(fx.expectedPresentationV2.selfCorrected ? true : undefined)
    // Cold fingerprint == live fingerprint == persisted fingerprint.
    expect(p.fingerprint).toBe(doc.fingerprint)
    // Every committed block's text is intact (never re-guessed from content).
    const prose = p.blocks.filter((b) => b.type === 'prose')
    expect(prose.map((b) => (b as { text: string }).text)).toEqual(fx.expectedFinalVisible.map((b) => b.text))
  })

  it('a truncated raw timeline cannot drop committed prose (F-14 prose part)', () => {
    const doc = run.document!
    const p = buildAgentPresentationV2({
      messageId: fx.messageId,
      timeline: run.timeline.slice(0, 5),   // everything after tool A is gone
      document: doc,
    })
    const ids = p.blocks.filter((b) => b.type === 'prose').map((b) => b.id)
    expect(ids).toEqual(fx.expectedFinalVisible.map((b) => b.id))
  })

  it('derives the v1 projection for legacy clients from the same document', () => {
    const doc = run.document!
    const v2 = buildAgentPresentationV2({ messageId: fx.messageId, timeline: run.timeline, document: doc })
    const v1 = presentationV1FromV2(v2)
    const prose = v1.blocks.filter((b): b is Extract<typeof b, { type: 'prose' }> => b.type === 'prose')
    expect(prose.map((b) => b.state)).toEqual(fx.expectedV1Projection.proseStates)
    // An older iOS build accepts only state nil/'final' — lead + final, as before.
    expect(prose.filter((b) => b.state === 'final').map((b) => b.text))
      .toEqual(fx.expectedV1Projection.legacyIosVisibleTexts)
    expect(v1.selfCorrected).toBe(true)
  })

  it('an old client attached to a v2 turn receives a deliberate v1 view', () => {
    const projected = run.output.map((e) => projectEventForProtocol(e, 1)).filter((e): e is WireEvent => e != null)
    expect(projected.map((e) => e.type)).toEqual(fx.expectedOldClientEventTypes)
    for (const e of projected) {
      expect('blockId' in e).toBe(false)
      expect('revision' in e).toBe(false)
    }
    const retry = projected.find((e) => e.type === 'verification_retry')!
    expect(retry).toMatchObject({ attempt: 1, maxAttempts: 1, categories: ['completion_claim'], snippets: [] })
  })

  it('same-batch delivery produces the same state as step-wise delivery (reducer is order-pure)', () => {
    let batched = createLiveProseState()
    for (const e of run.output) batched = applyProseEvent(batched, e)
    expect(visibleProseBlocks(batched).map((b) => ({ id: b.id, kind: b.kind, text: b.text })))
      .toEqual(fx.expectedFinalVisible)
  })
})

describe('prose lifecycle v1 — same transcript, legacy wire untouched', () => {
  const run = runScript(1)

  it('passes every runner event through byte-identical (old reducers stay scoped to the old wire)', () => {
    expect(run.output).toEqual(run.input)
    expect(run.output.some((e) => e.type === 'prose_start' || e.type === 'prose_commit' || e.type === 'prose_supersede')).toBe(false)
  })

  it('still writes the same authoritative document (cold progress for v2-capable readers)', () => {
    const v2 = runScript(2).document!
    expect({ ...run.document!, protocol: 2 }).toEqual(v2)
    expect(run.document!.protocol).toBe(1)
  })
})
