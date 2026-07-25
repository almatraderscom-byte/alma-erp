import { describe, expect, it } from 'vitest'
import {
  assertResolutionRequest,
  exactDimensionsFor,
  getResolutionContract,
  supportedTiersForAspect,
} from '@/lib/creative-studio/resolution-contract'

describe('Creative Studio resolution contract', () => {
  it('exposes only native xAI tiers and aspects', () => {
    expect(getResolutionContract('xai_imagine').supportedTiers).toEqual(['1k', '2k'])
    expect(getResolutionContract('xai_imagine').supportedAspects).not.toContain('4:5')
    expect(() => assertResolutionRequest({
      engine: 'xai_imagine',
      resolution: '4k',
      aspectRatio: '1:1',
    })).toThrow('resolution_unsupported:xai_imagine:4k:1:1')
    expect(() => assertResolutionRequest({
      engine: 'xai_imagine',
      resolution: '2k',
      aspectRatio: '4:5',
    })).toThrow('aspect_ratio_unsupported:xai_imagine:4:5')
  })

  it('uses exact Gemini dimensions for every Studio aspect', () => {
    expect(exactDimensionsFor('gemini', '4k', '4:5')).toEqual({ width: 3712, height: 4608 })
    expect(exactDimensionsFor('gemini', '2k', '9:16')).toEqual({ width: 1536, height: 2752 })
    expect(supportedTiersForAspect('gemini', '1:1')).toEqual(['1k', '2k', '4k'])
  })

  it('limits GPT Image 2 4K to exact landscape or portrait requests', () => {
    expect(supportedTiersForAspect('gpt', '4:5')).toEqual(['1k', '2k'])
    expect(supportedTiersForAspect('gpt', '16:9')).toEqual(['1k', '2k', '4k'])
    expect(exactDimensionsFor('gpt', '4k', '16:9')).toEqual({ width: 3840, height: 2160 })
  })

  it('never labels Seedream as 4K', () => {
    expect(supportedTiersForAspect('seedream', '16:9')).toEqual(['1k', '2k'])
    expect(() => assertResolutionRequest({
      engine: 'seedream',
      resolution: '4k',
      aspectRatio: '16:9',
    })).toThrow('resolution_unsupported:seedream:4k:16:9')
  })

  it('allows direct FASHN source-derived modes to omit an explicit aspect', () => {
    expect(() => assertResolutionRequest({
      engine: 'fashn',
      resolution: '4k',
    })).not.toThrow()
  })

  it('requires fixed and source-sized engines to omit named tiers', () => {
    expect(getResolutionContract('fal_fashn_v16').kind).toBe('fixed')
    expect(getResolutionContract('fal_flux_fill').kind).toBe('source')
    expect(() => assertResolutionRequest({
      engine: 'fal_fashn_v16',
      resolution: '2k',
    })).toThrow('resolution_not_applicable:fal_fashn_v16')
    expect(() => assertResolutionRequest({ engine: 'fal_flux_fill' })).not.toThrow()
  })
})
