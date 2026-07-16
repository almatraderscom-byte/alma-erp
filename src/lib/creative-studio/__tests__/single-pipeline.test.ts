import { describe, expect, it } from 'vitest'
import {
  PRODUCTION_CORE_AXES,
  PRODUCTION_MIN_CORE_AXIS,
  READINESS_ERRORS_BN,
  READINESS_WARNINGS_BN,
  buildRunPlan,
  normalizePipelineMode,
  productionAxesPass,
  repairableAxes,
} from '../single-pipeline'
import { pickSceneDiverse, BD_SCENES } from '@/lib/tryon/scene-pool'

describe('pipeline modes — bounded spend plans', () => {
  it('preview: exactly one economical paid generation, no strict gate', () => {
    const plan = buildRunPlan('preview')
    expect(plan.maxPaidGenerations).toBe(1)
    expect(plan.economical).toBe(true)
    expect(plan.strictAxisGate).toBe(false)
    expect(plan.labelBn).toContain('প্রিভিউ')
  })

  it('production: hard ceiling of 3 paid generations + strict axis gate', () => {
    const plan = buildRunPlan('production')
    expect(plan.maxPaidGenerations).toBe(3)
    expect(plan.economical).toBe(false)
    expect(plan.strictAxisGate).toBe(true)
    expect(plan.labelBn).toContain('৩')
  })

  it('mode normalization defaults to preview (never accidental spend)', () => {
    expect(normalizePipelineMode('production')).toBe('production')
    expect(normalizePipelineMode('preview')).toBe('preview')
    expect(normalizePipelineMode('bogus')).toBe('preview')
    expect(normalizePipelineMode(null)).toBe('preview')
  })
})

describe('production hard axis gate', () => {
  it('every core axis must be ≥4 — overall alone can NOT pass', () => {
    expect(PRODUCTION_MIN_CORE_AXIS).toBe(4)
    expect([...PRODUCTION_CORE_AXES]).toEqual(['garment_fidelity', 'model_preserved', 'anatomy'])
    expect(productionAxesPass({ garment_fidelity: 4, model_preserved: 5, anatomy: 4 })).toBe(true)
    // the audit finding: a 2/5 axis with a good overall must FAIL production
    expect(productionAxesPass({ garment_fidelity: 2, model_preserved: 5, anatomy: 5 })).toBe(false)
    expect(productionAxesPass({ garment_fidelity: 4, model_preserved: 3, anatomy: 5 })).toBe(false)
    expect(productionAxesPass({ garment_fidelity: 4, model_preserved: 4, anatomy: 3 })).toBe(false)
    expect(productionAxesPass({})).toBe(false)
  })

  it('only anatomy/composition are mask-repairable — never face or embroidery', () => {
    expect(repairableAxes({ anatomy: 3, composition: 3, garment_fidelity: 2, model_preserved: 2 }))
      .toEqual(['anatomy', 'composition'])
    expect(repairableAxes({ garment_fidelity: 1, model_preserved: 1, anatomy: 5, composition: 5 }))
      .toEqual([])
    expect(repairableAxes({})).toEqual([])
  })
})

describe('readiness messages', () => {
  it('every machine code has a Bangla correction', () => {
    for (const [code, msg] of Object.entries(READINESS_ERRORS_BN)) {
      expect(code).toBeTruthy()
      expect(msg.length).toBeGreaterThan(10)
    }
    expect(Object.keys(READINESS_WARNINGS_BN)).toEqual(['background_cluttered', 'pose_occlusion_risk'])
  })
})

describe('controlled scene diversity', () => {
  it('excludes recently used scenes', () => {
    const recent = BD_SCENES.slice(0, 4).map((s) => s.id)
    for (let i = 0; i < 50; i++) {
      const picked = pickSceneDiverse({}, recent, Math.random)
      expect(recent).not.toContain(picked.scene.id)
    }
  })

  it('falls back to the full pool when everything is recent', () => {
    const all = BD_SCENES.map((s) => s.id)
    const picked = pickSceneDiverse({}, all, () => 0.5)
    expect(picked.scene.id).toBeTruthy()
  })

  it('respects owner-taste weights inside the diverse pool', () => {
    const recent: string[] = []
    // disable every scene except one via weights
    const weights: Record<string, number> = {}
    for (const s of BD_SCENES) weights[s.id] = -3
    weights[BD_SCENES[2].id] = 0
    const picked = pickSceneDiverse(weights, recent, () => 0.99)
    expect(picked.scene.id).toBe(BD_SCENES[2].id)
  })
})
