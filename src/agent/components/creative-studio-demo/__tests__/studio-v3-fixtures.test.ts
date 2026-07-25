import { describe, expect, it } from 'vitest'
import {
  AVATARS,
  FINISH_LAYOUTS,
  FINISH_THEMES,
  GALLERY_ASSETS,
  GALLERY_TYPES,
  IMAGE_MODES,
  MASK_REPAIR_PRESETS,
  VIDEO_FINISH_TEMPLATES,
  agentPlanMatchesVersion,
  compatibleImageProviders,
  imageProviderSupports,
  videoModelSupports,
} from '../studio-v3-fixtures'

describe('Studio V3 capability truth', () => {
  it('keeps every production image mode and rejects misleading resolution options', () => {
    expect(IMAGE_MODES.map((mode) => mode.id)).toEqual([
      'generate',
      'product_to_model',
      'try_on',
      'swap',
      'face',
      'edit',
      'reel',
    ])

    expect(imageProviderSupports('grok', 'generate', '2K')).toBe(true)
    expect(imageProviderSupports('grok', 'generate', '4K')).toBe(false)
    expect(imageProviderSupports('fal-fashn', 'try_on', '1K')).toBe(true)
    expect(imageProviderSupports('fal-fashn', 'try_on', '2K')).toBe(false)
    expect(imageProviderSupports('fashn-direct', 'generate', '1K')).toBe(false)
  })

  it('keeps providers mode-aware and exposes research status without broad fallback', () => {
    const tryOnProviders = compatibleImageProviders('try_on')
    const generateProviders = compatibleImageProviders('generate')

    expect(generateProviders.map((provider) => provider.id)).toEqual(['grok'])
    expect(tryOnProviders.map((provider) => provider.id)).toContain('idm-vton')
    expect(tryOnProviders.find((provider) => provider.id === 'idm-vton')).toMatchObject({
      commercial: false,
      researchOnly: true,
    })
  })

  it('models verified video capabilities rather than a global quality promise', () => {
    expect(videoModelSupports('veo-preview', 6, '720p', '9:16')).toBe(true)
    expect(videoModelSupports('veo-preview', 6, '1080p', '9:16')).toBe(false)
    expect(videoModelSupports('veo-preview', 6, '720p', '1:1')).toBe(false)
    expect(videoModelSupports('veo-preview', 24, '720p', '9:16')).toBe(false)
    expect(videoModelSupports('owned-local', 30, '1080p', '1:1')).toBe(true)
    expect(videoModelSupports('owned-local', 30, '4K', '1:1')).toBe(false)
  })

  it('invalidates an Agent plan when the composition version advances', () => {
    expect(agentPlanMatchesVersion(12, 12)).toBe(true)
    expect(agentPlanMatchesVersion(12, 13)).toBe(false)
    expect(agentPlanMatchesVersion(14, 12)).toBe(false)
  })
})

describe('Studio V3 parity fixtures', () => {
  it('includes identity avatars and every library category', () => {
    expect(AVATARS).toHaveLength(5)
    expect(AVATARS.some((avatar) => avatar.canonical)).toBe(true)
    expect(GALLERY_TYPES.map((type) => type.id)).toEqual([
      'all',
      'image',
      'video',
      'audio',
      'voice',
      'avatar',
      'project',
    ])
    expect(GALLERY_ASSETS).toHaveLength(28)
  })

  it('keeps the exact finishing action families visible', () => {
    expect(MASK_REPAIR_PRESETS.map((preset) => preset.id)).toEqual([
      'replace_background',
      'remove_object',
      'repair_hand',
      'contact_shadow',
      'extend_canvas',
      'custom',
    ])
    expect(FINISH_LAYOUTS.map((layout) => layout.id)).toEqual([
      'lifestyle',
      'model_overlay',
      'product_card',
    ])
    expect(FINISH_THEMES).toEqual(['Default', 'Eid', 'Puja', 'Boishakh', 'Winter'])
    expect(VIDEO_FINISH_TEMPLATES).toEqual([
      'Price pop',
      'Lower third · code + name',
      'Logo watermark',
      'End card · CTA / code / price',
      'Countdown · days',
    ])
  })
})
