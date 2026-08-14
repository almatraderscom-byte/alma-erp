import { describe, expect, it } from 'vitest'
import { normalizeMediaPlan } from '@/agent/lib/media/plan-schema'
import { estimateMediaPlanCost, MEDIA_USD_TO_BDT } from '@/agent/lib/media/cost'

const rawPlan = {
  title: 'Test travel video',
  aspect: '9:16',
  language: 'bn',
  audio: { mode: 'vo', voice: 'owner_clone', musicBrief: null },
  models: { image: 'gemini-3-pro-image', video: 'seedance-1.0-pro' },
  personalization: { useOwnerPhotos: true, photoPaths: ['owner/a.jpg'] },
  captions: true,
  scenes: [
    { durationSec: 6, brief: 'দৃশ্য ১', voScript: 'x'.repeat(100), imagePrompt: 'scene one', clipBrief: 'clip one', usesOwnerPhoto: true },
    { durationSec: 6, brief: 'দৃশ্য ২', voScript: 'x'.repeat(100), imagePrompt: 'scene two', clipBrief: 'clip two', usesOwnerPhoto: false },
  ],
}

describe('normalizeMediaPlan', () => {
  it('clamps scene duration and computes total duration', () => {
    const plan = normalizeMediaPlan({ ...rawPlan, scenes: [{ ...rawPlan.scenes[0], durationSec: 99 }] })
    expect(plan.scenes[0].durationSec).toBe(10)
    expect(plan.durationSec).toBe(10)
  })

  it('drops scenes without brief/imagePrompt and rejects empty plans', () => {
    const plan = normalizeMediaPlan({ ...rawPlan, scenes: [...rawPlan.scenes, { durationSec: 5, brief: '', imagePrompt: '' }] })
    expect(plan.scenes).toHaveLength(2)
    expect(() => normalizeMediaPlan({ ...rawPlan, scenes: [] })).toThrow()
  })

  it('keeps scene indices contiguous when an invalid scene sits between valid ones', () => {
    const plan = normalizeMediaPlan({
      ...rawPlan,
      scenes: [{ durationSec: 5, brief: '', imagePrompt: '' }, ...rawPlan.scenes],
    })
    expect(plan.scenes.map((s) => s.idx)).toEqual([1, 2])
  })

  it('rejects VO mode when any scene lacks a voScript', () => {
    const scenes = [rawPlan.scenes[0], { ...rawPlan.scenes[1], voScript: '' }]
    expect(() => normalizeMediaPlan({ ...rawPlan, scenes })).toThrow(/S2/)
    // music-only mode is fine without scripts
    const plan = normalizeMediaPlan({ ...rawPlan, scenes, audio: { mode: 'music', musicBrief: 'calm' } })
    expect(plan.scenes).toHaveLength(2)
  })

  it('falls back to safe model defaults on unknown ids', () => {
    const plan = normalizeMediaPlan({ ...rawPlan, models: { image: 'bogus', video: 'bogus' } })
    expect(plan.models.image).toBe('gemini-3-pro-image')
    expect(plan.models.video).toBe('seedance-1.0-pro')
  })
})

describe('estimateMediaPlanCost', () => {
  it('total equals the sum of its lines, BDT is the rounded conversion', () => {
    const plan = normalizeMediaPlan(rawPlan)
    const est = estimateMediaPlanCost(plan)
    const sum = est.lines.reduce((acc, l) => acc + l.usd, 0)
    expect(est.totalUsd).toBeCloseTo(sum, 6)
    expect(est.totalBdt).toBe(Math.round(est.totalUsd * MEDIA_USD_TO_BDT))
    expect(est.totalUsd).toBeGreaterThan(0)
  })

  it('dropping VO for music changes the quote (revision re-quotes)', () => {
    const vo = estimateMediaPlanCost(normalizeMediaPlan(rawPlan))
    const music = estimateMediaPlanCost(
      normalizeMediaPlan({ ...rawPlan, audio: { mode: 'music', voice: null, musicBrief: 'upbeat' } }),
    )
    expect(music.totalUsd).not.toBe(vo.totalUsd)
    expect(music.lines.some((l) => l.label.includes('মিউজিক'))).toBe(true)
    expect(music.lines.some((l) => l.label.includes('ভয়েসওভার'))).toBe(false)
  })

  it('cheaper clip model lowers the total', () => {
    const pro = estimateMediaPlanCost(normalizeMediaPlan(rawPlan))
    const lite = estimateMediaPlanCost(
      normalizeMediaPlan({ ...rawPlan, models: { ...rawPlan.models, video: 'seedance-1.0-lite' } }),
    )
    expect(lite.totalUsd).toBeLessThan(pro.totalUsd)
  })
})
