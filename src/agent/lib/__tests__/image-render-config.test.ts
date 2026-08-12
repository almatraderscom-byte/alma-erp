import { describe, expect, it } from 'vitest'
import {
  buildImageRenderQuote,
  buildImageRenderSelection,
  imageRenderConfigFingerprint,
  imageRenderConfigForAction,
  imageRenderMirrorMatches,
  imageRenderPayloadMirror,
  isImageRenderQuoteForConfig,
  normalizeImagePresetId,
  resolveImageRenderConfig,
} from '@/agent/lib/image-render-config'

const base = {
  model: 'gemini-3-pro-image' as const,
  presetId: 'social_post' as const,
  imageSize: '2K' as const,
  quality: 'pro' as const,
  variationCount: 4,
  pipelineMode: 'preview' as const,
}

describe('image render config', () => {
  it('resolves the exact worker dimensions for every advertised preset/tier', () => {
    // These numbers are the worker's decoded-byte validation targets; the card
    // may only promise pixels the worker will actually verify.
    expect(resolveImageRenderConfig(base)).toMatchObject({
      aspectRatio: '4:5', width: 1856, height: 2304,
    })
    expect(resolveImageRenderConfig({ ...base, presetId: 'square', imageSize: '4K' }))
      .toMatchObject({ width: 4096, height: 4096 })
    expect(resolveImageRenderConfig({ ...base, model: 'seedream-5.0-pro' }))
      .toMatchObject({ width: 1824, height: 2272 })
    expect(resolveImageRenderConfig({
      ...base, model: 'gpt-image-2', presetId: 'reel_story', imageSize: '4K',
    })).toMatchObject({ width: 2160, height: 3840 })
  })

  it('refuses combinations the worker would refuse, with no silent downgrade', () => {
    expect(() => resolveImageRenderConfig({ ...base, model: 'seedream-5.0-pro', imageSize: '4K' }))
      .toThrow(/image_/)
    expect(() => resolveImageRenderConfig({
      ...base, model: 'gpt-image-2', presetId: 'square', imageSize: '4K',
    })).toThrow(/image_/)
  })

  it('maps ALMA quality onto the provider vocabulary honestly', () => {
    expect(resolveImageRenderConfig({ ...base, model: 'gpt-image-2' }).providerQuality).toBe('high')
    expect(resolveImageRenderConfig({
      ...base, model: 'gpt-image-2', quality: 'standard',
    }).providerQuality).toBe('medium')
    expect(resolveImageRenderConfig(base).providerQuality).toBe('pro')
  })

  it('changes the quote fingerprint for every priced input, aspect included', () => {
    const config = resolveImageRenderConfig(base)
    const variants = [
      resolveImageRenderConfig({ ...base, presetId: 'reel_story' }),
      resolveImageRenderConfig({ ...base, imageSize: '1K' }),
      resolveImageRenderConfig({ ...base, quality: 'standard' }),
      resolveImageRenderConfig({ ...base, variationCount: 2 }),
      resolveImageRenderConfig({ ...base, model: 'gemini-3.1-flash-image' }),
    ]
    const fingerprints = new Set([config, ...variants].map(imageRenderConfigFingerprint))
    expect(fingerprints.size).toBe(variants.length + 1)
  })

  it('binds the v2 quote to the complete selection and detects drift', () => {
    const config = resolveImageRenderConfig(base)
    const quote = buildImageRenderQuote(config)
    expect(quote).toMatchObject({
      renderVersion: 2, presetId: 'social_post', aspectRatio: '4:5',
      width: 1856, height: 2304, requestedImages: 4,
    })
    expect(isImageRenderQuoteForConfig(quote, config)).toBe(true)
    const edited = resolveImageRenderConfig({ ...base, presetId: 'reel_story' })
    expect(isImageRenderQuoteForConfig(quote, edited)).toBe(false)
  })

  it('projects options against the pending config with reasons, never omission', () => {
    const selection = buildImageRenderSelection({
      config: resolveImageRenderConfig({ ...base, imageSize: '4K' }),
      revision: 3,
    })
    expect(selection.revision).toBe(3)
    const seedream = selection.modelOptions.find((option) => option.id === 'seedream-5.0-pro')
    expect(seedream?.enabled).toBe(false)
    expect(seedream?.unavailableReason).toBeTruthy()
    expect(selection.presetOptions).toHaveLength(4)
    expect(selection.countOptions).toEqual([1, 2, 3, 4])
    const size4k = selection.sizeOptions.find((option) => option.id === '4K')
    expect(size4k).toMatchObject({ enabled: true, width: 3712, height: 4608 })
  })

  it('reads a legacy v1 row through its payload mirror', () => {
    const config = imageRenderConfigForAction({
      imageModel: 'gemini-3-pro-image',
      payload: { quality: 'pro', imageSize: '2K', aspectRatio: '9:16', variationCount: 3 },
    })
    expect(config).toMatchObject({
      presetId: 'reel_story', width: 1536, height: 2752, variationCount: 3,
    })
  })

  it('keeps the payload mirror and canonical config as one truth', () => {
    const config = resolveImageRenderConfig(base)
    const mirrored = imageRenderPayloadMirror({ prompt: 'x', aspectRatio: '1:1' }, config)
    expect(imageRenderMirrorMatches(mirrored, config)).toBe(true)
    // A diverged mirror — the exact state approval must refuse to queue.
    expect(imageRenderMirrorMatches({ ...mirrored, aspectRatio: '1:1' }, config)).toBe(false)
    expect(imageRenderMirrorMatches({ ...mirrored, variationCount: 1 }, config)).toBe(false)
  })

  it('falls back to a preset from the aspect, then to the social default', () => {
    expect(normalizeImagePresetId('reel_story')).toBe('reel_story')
    expect(normalizeImagePresetId(undefined, '16:9')).toBe('landscape')
    expect(normalizeImagePresetId('poster', 'nonsense')).toBe('social_post')
  })
})
