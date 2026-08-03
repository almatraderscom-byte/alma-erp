import { describe, expect, it } from 'vitest'
import {
  GARMENT_VISION_MODEL,
  NEGATIVE_DIRECTIVES,
  autoProductReferenceError,
  buildTryOnPrompt,
  isUsableGarmentClassification,
} from '../art-director'

describe('production try-on fidelity prompt', () => {
  it('uses a current GA multimodal model for product preflight', () => {
    expect(GARMENT_VISION_MODEL).toBe('gemini-3.6-flash')
    expect(GARMENT_VISION_MODEL).not.toContain('gemini-2.0')
  })

  it('forbids invented body art and preserves exact garment/model attributes', () => {
    const prompt = buildTryOnPrompt({
      garmentType: 'panjabi',
      modelNotes: 'adult Bangladeshi father',
      extra: 'warm premium studio',
    })
    expect(prompt).toContain('GARMENT FIDELITY (99% rule)')
    expect(prompt).toContain("MODEL IDENTITY")
    expect(prompt).toContain('adding tattoos, body art, scars')
    expect(prompt).toContain('warm premium studio')
    expect(NEGATIVE_DIRECTIVES).toContain('skin markings')
  })

  it('does not reuse a transient unknown vision result as a product classification', () => {
    expect(isUsableGarmentClassification({
      garmentType: 'unknown',
      dominantColors: [],
      fabricGuess: '',
      embroideryZones: [],
      hasContrastBottom: false,
      suggestedRole: 'single',
      notes: '',
    })).toBe(false)
    expect(isUsableGarmentClassification({
      garmentType: 'family_matching_set',
      dominantColors: ['rose'],
      fabricGuess: 'cotton',
      embroideryZones: ['collar'],
      hasContrastBottom: true,
      suggestedRole: 'family',
      notes: 'four coordinated pieces',
    })).toBe(true)
    const family = {
      garmentType: 'family_matching_set' as const,
      dominantColors: ['rose'],
      fabricGuess: 'cotton',
      embroideryZones: ['collar'],
      hasContrastBottom: true,
      suggestedRole: 'family' as const,
      notes: 'four coordinated pieces',
    }
    expect(autoProductReferenceError(family)).toBe('family_product_requires_role_crop')
    expect(autoProductReferenceError(family, true)).toBeNull()
    expect(autoProductReferenceError({
      ...family,
      visibleWearers: 1,
      photoType: 'on_model',
    })).toBeNull()
    expect(autoProductReferenceError({
      ...family,
      visibleWearers: 2,
      photoType: 'multi_person',
    })).toBe('family_product_requires_role_crop')
    expect(autoProductReferenceError({
      ...family,
      visibleWearers: 2,
      photoType: 'multi_person',
      singleGarmentDominant: true,
    })).toBeNull()
  })
})
