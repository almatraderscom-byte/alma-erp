import { describe, expect, it } from 'vitest'
import type { QCScore } from '@/lib/tryon/qc-gate'
import {
  SURFACE_THRESHOLDS,
  evaluateSurfaceScore,
  percentile,
  summarizeEngine,
  surfaceForStudioMode,
  type EvalAttempt,
} from '../eval-types'
import { compareEngines, scoreEngine } from '../model-comparison'

function score(overrides: Partial<QCScore> = {}): QCScore {
  return {
    garment_fidelity: 4,
    model_preserved: 4,
    anatomy: 4,
    brand_consistency: 4,
    text_legibility: 5,
    composition: 4,
    overall: 4,
    fail_reasons: [],
    fix_hint: '',
    ...overrides,
  }
}

function attempt(engine: EvalAttempt['engine'], over: Partial<EvalAttempt> = {}): EvalAttempt {
  return {
    caseId: 'case-1',
    engine,
    latencyMs: 15_000,
    costUsd: 0.075,
    score: score(),
    pass: true,
    ...over,
  }
}

describe('surface thresholds', () => {
  it('every surface hard-gates the core axes at ≥ its floor', () => {
    expect(evaluateSurfaceScore(score(), 'single_tryon')).toBe(true)
    expect(evaluateSurfaceScore(score({ garment_fidelity: 3 }), 'single_tryon')).toBe(false)
    expect(evaluateSurfaceScore(score({ anatomy: 3, overall: 5 }), 'family')).toBe(false)
  })

  it('precision edits demand untouched identity (core floor 5)', () => {
    expect(SURFACE_THRESHOLDS.precision_edit.minCoreAxis).toBe(5)
    expect(evaluateSurfaceScore(score({ garment_fidelity: 4, model_preserved: 5, anatomy: 5 }), 'precision_edit')).toBe(false)
    expect(evaluateSurfaceScore(score({ garment_fidelity: 5, model_preserved: 5, anatomy: 5 }), 'precision_edit')).toBe(true)
  })

  it('poster tolerates softer anatomy but demands text/brand ≥4', () => {
    expect(evaluateSurfaceScore(score({ anatomy: 3, composition: 4 }), 'poster')).toBe(true)
    expect(evaluateSurfaceScore(score({ composition: 3 }), 'poster')).toBe(false)
  })

  it('maps studio modes to surfaces', () => {
    expect(surfaceForStudioMode('try_on', 'single')).toBe('single_tryon')
    expect(surfaceForStudioMode('product_to_model', 'father_son')).toBe('family')
    expect(surfaceForStudioMode('edit')).toBe('precision_edit')
  })
})

describe('percentile + engine summaries', () => {
  it('percentile is deterministic', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20)
    expect(percentile([10, 20, 30, 40], 95)).toBe(40)
    expect(percentile([], 50)).toBe(0)
  })

  it('summarizes pass rate, latency, cost and weakest-axis histogram', () => {
    const attempts: EvalAttempt[] = [
      attempt('fashn', { latencyMs: 10_000, costUsd: 0.225 }),
      attempt('fashn', {
        latencyMs: 30_000,
        costUsd: 0.225,
        pass: false,
        score: score({ garment_fidelity: 2, overall: 3 }),
      }),
      attempt('fashn', { error: 'timeout', score: undefined, pass: false, costUsd: 0 }),
    ]
    const r = summarizeEngine('fashn', attempts)
    expect(r.cases).toBe(3)
    expect(r.errors).toBe(1)
    expect(r.passRate).toBe(50) // 1 of 2 scored
    expect(r.p50LatencyMs).toBe(10_000)
    expect(r.totalCostUsd).toBe(0.45)
    expect(r.failureAxes.garment_fidelity).toBe(1)
  })
})

describe('deterministic engine comparison', () => {
  it('ranks by the fixed formula and recommends only with real margin', () => {
    const attempts: EvalAttempt[] = [
      // fashn: perfect
      attempt('fashn', { score: score({ overall: 5, garment_fidelity: 5, model_preserved: 5, anatomy: 5 }) }),
      attempt('fashn', { caseId: 'case-2', score: score({ overall: 5, garment_fidelity: 5, model_preserved: 5, anatomy: 5 }) }),
      // idm: poor
      attempt('fal_idm_vton', { pass: false, score: score({ overall: 3, garment_fidelity: 2 }) }),
      attempt('fal_idm_vton', { caseId: 'case-2', pass: false, score: score({ overall: 3, garment_fidelity: 3 }) }),
    ]
    const cmp = compareEngines(attempts)
    expect(cmp.rankings[0].engine).toBe('fashn')
    expect(cmp.recommended).toBe('fashn')
    expect(cmp.verdictBn).toContain('আপনার সিদ্ধান্ত')
  })

  it('close race → no recommendation (honest "no change")', () => {
    const attempts: EvalAttempt[] = [
      attempt('fashn'),
      attempt('fal_fashn_v16', { costUsd: 0.075 }),
    ]
    const cmp = compareEngines(attempts)
    expect(cmp.recommended).toBeNull()
    expect(cmp.verdictBn).toContain('স্পষ্টভাবে এগিয়ে নেই')
  })

  it('owner ভালো/বাদ tallies shift the deterministic score', () => {
    const base = summarizeEngine('fashn', [attempt('fashn')])
    const withLove = scoreEngine(base, { good: 5, bad: 0 })
    const withHate = scoreEngine(base, { good: 0, bad: 5 })
    expect(withLove - withHate).toBe(40) // ±5 net × weight 4
  })
})
