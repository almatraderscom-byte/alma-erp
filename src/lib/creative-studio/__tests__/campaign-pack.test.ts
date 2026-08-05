import { describe, expect, it } from 'vitest'
import {
  assertCampaignPackConfirmation,
  buildCampaignPackManifest,
  CampaignPackContractError,
} from '@/lib/creative-studio/campaign-pack'

const product = {
  code: 'ALMA-101',
  name: 'Premium Panjabi',
  priceBdt: 3_490,
  sourceImage: 'https://example.com/alma-101.jpg',
}

const recipe = {
  id: 'recipe-1',
  name: 'ALMA Premium',
  version: 3,
  lockedAt: '2026-07-25T00:00:00.000Z',
  captionTone: 'premium',
  finishTheme: 'warm',
  musicVibe: 'premium',
  qcLevel: 'strict',
  spendCeilingBdt: 125,
}

describe('deterministic campaign-pack manifest', () => {
  it('builds the default free pack with two drafts and every required output', () => {
    const manifest = buildCampaignPackManifest({
      projectId: 'project-1',
      product,
      recipe: { ...recipe, spendCeilingBdt: 0 },
    })

    expect(manifest.stages.map((stage) => stage.id)).toEqual([
      'draft-a',
      'draft-b',
      'hero-4x5',
      'post-1x1',
      'story-9x16',
      'caption-bn',
    ])
    expect(manifest.stages.filter((stage) => stage.phase === 'draft')).toHaveLength(2)
    expect(manifest.estimatedCostUsd).toBe(0)
    expect(manifest.hardCostCeilingUsd).toBe(1)
    expect(manifest.requiresPaidConfirmation).toBe(false)
    expect(() => assertCampaignPackConfirmation(manifest, 0)).not.toThrow()
  })

  it('keeps the optional family + 6s reel pack below the hard $1 ceiling', () => {
    const manifest = buildCampaignPackManifest({
      projectId: 'project-1',
      product,
      recipe,
      options: { includeFamily: true, includeReel: true },
    })

    expect(manifest.estimatedCostUsd).toBe(0.94)
    expect(manifest.estimatedCostBdt).toBe(118)
    expect(manifest.stages.find((stage) => stage.id === 'family-4x5')?.engine)
      .toBe('Gemini 3.1 Flash Image')
    expect(manifest.stages.find((stage) => stage.id === 'reel-6s')?.engine)
      .toBe('Veo 3.1')
    expect(() => assertCampaignPackConfirmation(manifest, 0.94)).not.toThrow()
  })

  it('requires an exact owner-visible confirmation and respects the recipe ceiling', () => {
    const manifest = buildCampaignPackManifest({
      projectId: 'project-1',
      product,
      recipe: { ...recipe, spendCeilingBdt: 100 },
      options: { includeFamily: true, includeReel: true },
    })

    expect(() => assertCampaignPackConfirmation(manifest, 0))
      .toThrowError(CampaignPackContractError)
    expect(() => assertCampaignPackConfirmation(manifest, 0.94))
      .toThrowError('recipe_cost_cap_exceeded')
  })

  it('rejects an unlocked recipe before any stage can be planned', () => {
    expect(() => buildCampaignPackManifest({
      projectId: 'project-1',
      product,
      recipe: { ...recipe, lockedAt: '' },
    })).toThrowError('recipe_must_be_locked')
  })
})
