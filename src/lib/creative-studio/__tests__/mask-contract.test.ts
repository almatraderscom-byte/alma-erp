import { describe, expect, it } from 'vitest'
import {
  FLUX_FILL_DEFAULTS,
  MASK_EDIT_VALUE,
  MASK_KEEP_VALUE,
  MASK_PRESETS,
  assertMaskDimensionsMatch,
  buildFillPrompt,
  estimateFluxFillCostUsd,
  featherRadiusPx,
  getMaskPreset,
  maskCoverageRatio,
  validateMaskCoverage,
} from '../mask-contract'

describe('mask polarity contract', () => {
  it('white = edit, black = keep (locked values)', () => {
    expect(MASK_EDIT_VALUE).toBe(255)
    expect(MASK_KEEP_VALUE).toBe(0)
  })

  it('coverage counts white/anti-aliased-white pixels as edit', () => {
    // 2x2 fixture: [edit, keep, boundary-gray(160), boundary-gray(90)]
    const gray = new Uint8Array([255, 0, 160, 90])
    expect(maskCoverageRatio(gray)).toBe(0.5) // 255 + 160 count; 0 + 90 don't
    expect(maskCoverageRatio(new Uint8Array([]))).toBe(0)
  })

  it('rejects empty and delete-everything masks before spending money', () => {
    expect(() => validateMaskCoverage(0)).toThrow('mask_empty')
    expect(() => validateMaskCoverage(0.0001)).toThrow('mask_empty')
    expect(() => validateMaskCoverage(0.99)).toThrow('mask_covers_everything')
    expect(() => validateMaskCoverage(0.3)).not.toThrow()
  })
})

describe('mask dimensions', () => {
  it('must match exactly', () => {
    expect(() => assertMaskDimensionsMatch({ width: 100, height: 200 }, { width: 100, height: 200 })).not.toThrow()
    expect(() => assertMaskDimensionsMatch({ width: 100, height: 200 }, { width: 100, height: 201 })).toThrow('mask_dimensions_mismatch')
    expect(() => assertMaskDimensionsMatch({ width: 100, height: 200 }, { width: 0, height: 200 })).toThrow('mask_dimensions_unreadable')
  })
})

describe('presets and prompts', () => {
  it('ships all six roadmap presets', () => {
    expect(MASK_PRESETS.map((p) => p.id)).toEqual([
      'replace_background',
      'remove_object',
      'repair_hand',
      'contact_shadow',
      'extend_canvas',
      'custom',
    ])
    for (const p of MASK_PRESETS) expect(p.labelBn).toBeTruthy()
  })

  it('builds prompts with owner detail; custom requires text', () => {
    expect(buildFillPrompt('replace_background', 'old Dhaka rooftop at golden hour')).toContain('old Dhaka rooftop')
    expect(buildFillPrompt('remove_object', '')).toContain('Remove everything inside the masked region')
    expect(buildFillPrompt('custom', 'make the wall light green')).toBe('make the wall light green')
    expect(() => buildFillPrompt('custom', '  ')).toThrow('custom_prompt_required')
    expect(getMaskPreset('nonsense').id).toBe('custom')
  })
})

describe('cost estimate — $0.05/MP rounded UP (mirrors worker calc)', () => {
  it('rounds megapixels up', () => {
    expect(estimateFluxFillCostUsd(1000, 1000)).toBe(0.05) // exactly 1MP
    expect(estimateFluxFillCostUsd(1024, 1024)).toBe(0.1) // 1.05MP → 2MP
    expect(estimateFluxFillCostUsd(2048, 2048)).toBe(0.25) // 4.19MP → 5MP
    expect(estimateFluxFillCostUsd(100, 100)).toBe(0.05) // tiny → 1MP floor
    expect(estimateFluxFillCostUsd(1000, 1000, 2)).toBe(0.1)
  })
})

describe('defaults and feather', () => {
  it('precision defaults locked: no prompt rewriting, 1 png image', () => {
    expect(FLUX_FILL_DEFAULTS.enhancePrompt).toBe(false)
    expect(FLUX_FILL_DEFAULTS.numImages).toBe(1)
    expect(FLUX_FILL_DEFAULTS.outputFormat).toBe('png')
  })

  it('feather scales with image size, capped', () => {
    expect(featherRadiusPx(2048, 'none')).toBe(0)
    expect(featherRadiusPx(2048, 'soft')).toBe(8)
    expect(featherRadiusPx(2048, 'wide')).toBe(21)
    expect(featherRadiusPx(100000, 'wide')).toBe(48)
  })
})
