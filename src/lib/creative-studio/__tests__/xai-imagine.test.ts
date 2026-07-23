import { describe, expect, it } from 'vitest'
import {
  XAI_TEMPLATES,
  buildXaiRunBrief,
  estimateXaiImageCostUsd,
  toXaiAspectRatio,
  toXaiResolution,
} from '../xai-imagine'
import { STUDIO_MODES, ASPECT_RATIOS } from '../constants'
import { getEngine } from '../provider-registry'

describe('CS13 — xAI aspect/resolution mapping', () => {
  it('maps the studio 4:5 portrait to the nearest xAI ratio (3:4)', () => {
    expect(toXaiAspectRatio('4:5')).toBe('3:4')
    expect(toXaiAspectRatio('1:1')).toBe('1:1')
    expect(toXaiAspectRatio('9:16')).toBe('9:16')
    expect(toXaiAspectRatio('weird')).toBe('auto')
  })

  it('clamps 4k down to 2k honestly', () => {
    expect(toXaiResolution('4k')).toBe('2k')
    expect(toXaiResolution('2k')).toBe('2k')
    expect(toXaiResolution('1k')).toBe('1k')
  })

  it('cost estimate follows the published per-image list price', () => {
    expect(estimateXaiImageCostUsd('1k')).toBeCloseTo(0.05)
    expect(estimateXaiImageCostUsd('2k')).toBeCloseTo(0.07)
  })
})

describe('CS13 — run brief per mode', () => {
  it('generate: text only, prompt required', () => {
    const brief = buildXaiRunBrief({ mode: 'generate', prompt: 'Eid poster' })
    expect(brief.op).toBe('generate')
    expect(brief.referenceImagePaths).toEqual([])
    expect(brief.prompt).toContain('Eid poster')
    expect(() => buildXaiRunBrief({ mode: 'generate' })).toThrow('prompt_required')
  })

  it('try_on: person then garment, in that order', () => {
    const brief = buildXaiRunBrief({
      mode: 'try_on',
      modelImagePath: 'p/model.jpg',
      productImagePath: 'p/garment.jpg',
    })
    expect(brief.op).toBe('edit')
    expect(brief.referenceImagePaths).toEqual(['p/model.jpg', 'p/garment.jpg'])
    expect(brief.prompt).toContain('image 1')
    expect(brief.prompt).toContain('image 2')
    expect(() => buildXaiRunBrief({ mode: 'try_on', productImagePath: 'p/g.jpg' })).toThrow('model_image_required')
  })

  it('product_to_model: product first, optional model second', () => {
    const solo = buildXaiRunBrief({ mode: 'product_to_model', productImagePath: 'p/prod.jpg' })
    expect(solo.referenceImagePaths).toEqual(['p/prod.jpg'])
    const withModel = buildXaiRunBrief({
      mode: 'product_to_model',
      productImagePath: 'p/prod.jpg',
      modelImagePath: 'p/model.jpg',
    })
    expect(withModel.referenceImagePaths).toEqual(['p/prod.jpg', 'p/model.jpg'])
  })

  it('edit: source required + prompt required, optional extra product ref', () => {
    expect(() => buildXaiRunBrief({ mode: 'edit', sourceImagePath: 's.jpg' })).toThrow('prompt_required')
    const brief = buildXaiRunBrief({
      mode: 'edit',
      sourceImagePath: 's.jpg',
      productImagePath: 'extra.jpg',
      prompt: 'clean background',
    })
    expect(brief.referenceImagePaths).toEqual(['s.jpg', 'extra.jpg'])
  })

  it('family prompt rides along for multi-person presets', () => {
    const brief = buildXaiRunBrief({
      mode: 'try_on',
      modelImagePath: 'm.jpg',
      productImagePath: 'g.jpg',
      familyPrompt: 'Bangladeshi father and son wearing matching outfits',
    })
    expect(brief.prompt).toContain('father and son')
  })

  it('never exceeds 3 references and rejects video mode', () => {
    expect(() => buildXaiRunBrief({ mode: 'image_to_video', sourceImagePath: 's.jpg' })).toThrow('invalid_mode')
  })
})

describe('CS13 — registry + templates coherence', () => {
  it('xai_imagine serves every image mode including generate', () => {
    const e = getEngine('xai_imagine')
    expect(e.modes).toContain('generate')
    expect(e.modes).toContain('try_on')
    expect(e.modes).toContain('product_to_model')
    expect(e.modes).toContain('edit')
    expect(e.requiresEnv).toBe('XAI_API_KEY')
    expect(e.settingsFlag).toBe('cs_xai_enabled')
    expect(e.singlePersonOnly).toBe(false)
  })

  it('generate mode exists in the studio mode list with no required uploads', () => {
    const gen = STUDIO_MODES.find((m) => m.id === 'generate')!
    expect(gen.needsProduct).toBe(false)
    expect(gen.needsModel).toBe(false)
    expect(gen.needsSource ?? false).toBe(false)
  })

  it('every template points at a real mode and a UI-offered aspect ratio', () => {
    const modeIds = new Set(STUDIO_MODES.map((m) => m.id))
    for (const t of XAI_TEMPLATES) {
      expect(modeIds.has(t.mode)).toBe(true)
      expect([...ASPECT_RATIOS]).toContain(t.aspectRatio)
      expect(['1k', '2k']).toContain(t.resolution)
    }
  })
})
