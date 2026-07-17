/**
 * Phase 31 — replay corpus + runner integrity + BASELINE LOCK (pure layer).
 *
 * The corpus encodes the roadmap's DESIRED behaviour; current-code failures
 * are baseline findings. This suite:
 *   1. validates the corpus (shape, PII, category minimums),
 *   2. proves the runner is deterministic (CI-stable),
 *   3. LOCKS the measured baseline numbers — if a code change moves any of
 *      them (better or worse), CI surfaces it and the numbers are updated
 *      deliberately with the phase that moved them. Never weaken a fixture
 *      to make current code pass (roadmap Phase 31 exit gate).
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  loadCorpus,
  runReplayCorpus,
  REPLAY_NOW,
} from '@/agent/replay/run-agent-replay'
import { REPLAY_CATEGORIES, type ReplayCategory } from '@/agent/replay/replay-types'

const FIXTURES = join(process.cwd(), 'src/agent/replay/fixtures')

describe('phase 31 corpus', () => {
  it('loads with zero validation errors and meets every category minimum', () => {
    const { cases, errors } = loadCorpus(FIXTURES)
    expect(errors).toEqual([])
    expect(cases.length).toBeGreaterThanOrEqual(150)
    const counts = new Map<ReplayCategory, number>()
    for (const c of cases) counts.set(c.category, (counts.get(c.category) ?? 0) + 1)
    for (const [cat, min] of Object.entries(REPLAY_CATEGORIES)) {
      expect(counts.get(cat as ReplayCategory) ?? 0, `category ${cat}`).toBeGreaterThanOrEqual(min)
    }
  })

  it('contains no live secrets, emails, or BD phone numbers', () => {
    const { cases } = loadCorpus(FIXTURES)
    const blob = JSON.stringify(cases)
    expect(/\+?88\s?0?1[3-9]\d{2}[-\s]?\d{6}/.test(blob)).toBe(false)
    expect(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(blob)).toBe(false)
    expect(/sk-[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}/.test(blob)).toBe(false)
  })

  it('every case asserts at least one decision and ids are unique', () => {
    const { cases } = loadCorpus(FIXTURES)
    const ids = new Set<string>()
    for (const c of cases) {
      expect(Object.keys(c.expect2).length, c.id).toBeGreaterThan(0)
      expect(ids.has(c.id), `duplicate id ${c.id}`).toBe(false)
      ids.add(c.id)
    }
  })
})

describe('phase 31 runner (real decision code, pure layer)', () => {
  it('is deterministic across runs', async () => {
    const a = await runReplayCorpus(FIXTURES, { now: REPLAY_NOW })
    const b = await runReplayCorpus(FIXTURES, { now: REPLAY_NOW })
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b))
  })

  it('locks the measured baseline (update ONLY with the phase that moves it)', async () => {
    const r = await runReplayCorpus(FIXTURES, { now: REPLAY_NOW })
    expect(r.totalCases).toBe(150)

    // Invariants that must stay perfect — a drop is a live regression.
    // Phase 31 baseline was binding 70.1% / continuation 81.6% / 23 repeated-
    // effect risks; Phase 32's continuity resolver closed all three, so they
    // are now locked as invariants (roadmap gate: binding ≥99%, risks 0).
    expect(r.metrics.fastPathAccuracy).toBe(1)
    expect(r.metrics.routineIntentAccuracy).toBe(1)
    expect(r.metrics.packPrecision).toBe(1)
    expect(r.metrics.resumeBriefAccuracy).toBe(1)
    expect(r.metrics.autoContinueAccuracy).toBe(1)
    expect(r.metrics.bindingAccuracy).toBe(1)
    expect(r.metrics.continuationTextAccuracy).toBe(1)
    expect(r.metrics.repeatedEffectRiskCount).toBe(0)

    // Honest remaining gap: Banglish tool-pack recall (state-router
    // INTENT_RULES) — Phase 37's ≥95% recall gate owns it.
    expect(r.totalPassed).toBe(143)
    expect(r.totalFailed).toBe(7)
    expect(r.metrics.packRecall).toBeCloseTo(0.8478, 3)
  })

  it('stamps every result with a stable trace id and behaviour version', async () => {
    const r = await runReplayCorpus(FIXTURES, { now: REPLAY_NOW })
    const traces = new Set(r.results.map((x) => x.traceId))
    expect(traces.size).toBe(r.results.length)
    for (const x of r.results) {
      expect(x.behaviorVersion).toBe('phase31-v1')
      expect(x.traceId).toMatch(/^rt-[0-9a-f]{8}$/)
    }
  })

  it('named scenario "2-3 replies later": the resolver binds "post ta koi?" back to the active run (fixed in Phase 32)', async () => {
    const r = await runReplayCorpus(FIXTURES, { now: REPLAY_NOW })
    const c = r.results.find((x) => x.id === 'rc-0144-cont-3replies-post-ta-koi')
    expect(c).toBeDefined()
    // Phase 31 measured this as the owner's "forgot after 2-3 replies" bug
    // (bound to new_task); the continuity resolver now binds the active run.
    const binding = c!.checks.find((k) => k.check === 'binding')
    expect(binding?.expected).toBe('active_workflow')
    expect(binding?.actual).toBe('active_workflow')
    expect(binding?.pass).toBe(true)
  })

  it('named scenario "three days later": checkpoint resume is deterministically bound (fixed in Phase 32)', async () => {
    const r = await runReplayCorpus(FIXTURES, { now: REPLAY_NOW })
    const c = r.results.find((x) => x.id === 'rc-0117-cont-gap3d-checkpoint')
    expect(c).toBeDefined()
    const binding = c!.checks.find((k) => k.check === 'binding')
    expect(binding?.expected).toBe('checkpoint')
    expect(binding?.actual).toBe('checkpoint')
    expect(binding?.pass).toBe(true)
    // The gap rule itself works: resume brief IS injected after 3 days.
    const brief = c!.checks.find((k) => k.check === 'resumeBrief')
    expect(brief?.pass).toBe(true)
  })

  it('named scenario "90 days later": resume brief + workflow state survive the gap rule', async () => {
    const r = await runReplayCorpus(FIXTURES, { now: REPLAY_NOW })
    const c = r.results.find((x) => x.id === 'rc-0122-cont-gap30d-no-state')
    expect(c).toBeDefined()
    expect(c!.checks.find((k) => k.check === 'resumeBrief')?.pass).toBe(true)
    expect(c!.checks.find((k) => k.check === 'binding')?.pass).toBe(true)
    const g90 = r.results.find((x) => x.id === 'rc-0123-cont-gap90d-what-were-we-doing')
    expect(g90!.checks.find((k) => k.check === 'resumeBrief')?.pass).toBe(true)
  })
})
