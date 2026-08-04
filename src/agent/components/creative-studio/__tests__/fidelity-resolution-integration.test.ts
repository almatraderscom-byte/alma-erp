import { describe, expect, it } from 'vitest'
import {
  buildDirectFashnInputs,
  makeReferenceContract,
} from '@/lib/creative-studio/advanced-image-capabilities'
import {
  assertResolutionRequest,
  exactDimensionsFor,
} from '@/lib/creative-studio/resolution-contract'
import {
  buildXaiRunBrief,
  toXaiAspectRatio,
  toXaiResolution,
} from '@/lib/creative-studio/xai-imagine'
import { resolutionEngineForGenericModel } from '@/agent/components/creative-studio/resolution-ui'

describe('CSE-A + CSE8 fidelity/resolution composition', () => {
  it('keeps xAI product/person order while enforcing only native size controls', () => {
    const brief = buildXaiRunBrief({
      mode: 'product_to_model',
      productImagePath: 'products/p1.jpg',
      modelImagePath: 'models/m1.jpg',
    })
    const contract = makeReferenceContract({
      mode: 'product_to_model',
      requestedEngine: 'xai_imagine',
      actualModel: 'grok-imagine-image-quality',
      bindings: brief.referenceImagePaths.map((path, index) => ({
        role: index === 0 ? 'product' as const : 'person' as const,
        path,
        source: index === 0 ? 'uploaded' as const : 'saved_model' as const,
        ...(index === 1 ? { sourceId: 'm1' } : {}),
        required: true,
      })),
    })

    expect(brief.referenceImagePaths).toEqual(['products/p1.jpg', 'models/m1.jpg'])
    expect(contract.bindings.map(({ role, path }) => ({ role, path }))).toEqual([
      { role: 'product', path: 'products/p1.jpg' },
      { role: 'person', path: 'models/m1.jpg' },
    ])
    expect(toXaiAspectRatio('3:4')).toBe('3:4')
    expect(toXaiResolution('2k')).toBe('2k')
    expect(() => assertResolutionRequest({
      engine: 'xai_imagine',
      resolution: '2k',
      aspectRatio: '3:4',
    })).not.toThrow()
    expect(() => assertResolutionRequest({
      engine: 'xai_imagine',
      resolution: '4k',
      aspectRatio: '3:4',
    })).toThrow('resolution_unsupported:xai_imagine:4k:3:4')
    expect(() => assertResolutionRequest({
      engine: 'xai_imagine',
      resolution: '2k',
      aspectRatio: '4:5',
    })).toThrow('aspect_ratio_unsupported:xai_imagine:4:5')
  })

  it('composes FASHN face_reference fidelity with its native 4K capability', () => {
    const inputs = buildDirectFashnInputs({
      mode: 'product_to_model',
      productImagePath: 'products/p2.jpg',
      modelImagePath: 'models/m2.jpg',
    })
    const contract = makeReferenceContract({
      mode: 'product_to_model',
      requestedEngine: 'fashn',
      actualModel: 'product-to-model',
      bindings: [
        { role: 'product', path: inputs.product_image, source: 'uploaded', required: true },
        { role: 'person', path: inputs.face_reference, source: 'saved_model', sourceId: 'm2', required: true },
      ],
    })

    expect(inputs).toEqual({
      product_image: 'products/p2.jpg',
      face_reference: 'models/m2.jpg',
      face_reference_mode: 'match_reference',
    })
    expect(contract.actualModel).toBe('product-to-model')
    expect(() => assertResolutionRequest({
      engine: 'fashn',
      resolution: '4k',
      aspectRatio: '4:5',
    })).not.toThrow()
  })

  it('uses the exact generic model snapshot to select the resolution contract', () => {
    const matrix = [
      ['gemini-3-pro-image', 'gemini', '4k', '4:5'],
      ['gpt-image-2', 'gpt', '4k', '16:9'],
      ['seedream-5.0-pro', 'seedream', '2k', '4:5'],
    ] as const

    for (const [model, engine, resolution, aspectRatio] of matrix) {
      expect(resolutionEngineForGenericModel(model)).toBe(engine)
      expect(() => assertResolutionRequest({ engine, resolution, aspectRatio })).not.toThrow()
    }
    expect(exactDimensionsFor('gpt', '4k', '16:9')).toEqual({ width: 3840, height: 2160 })
    expect(() => assertResolutionRequest({
      engine: resolutionEngineForGenericModel('seedream-5.0-pro'),
      resolution: '4k',
      aspectRatio: '16:9',
    })).toThrow('resolution_unsupported:seedream:4k:16:9')
  })

  it('keeps fixed Fal VTON references valid while rejecting a named tier', () => {
    const contract = makeReferenceContract({
      mode: 'try_on',
      requestedEngine: 'fal_fashn_v16',
      actualModel: 'fal-ai/fashn/tryon/v1.6',
      bindings: [
        { role: 'person', path: 'models/m3.jpg', source: 'saved_model', required: true },
        { role: 'product', path: 'products/p3.jpg', source: 'uploaded', required: true },
      ],
    })
    expect(contract.bindings).toHaveLength(2)
    expect(() => assertResolutionRequest({
      engine: 'fal_fashn_v16',
      resolution: '2k',
    })).toThrow('resolution_not_applicable:fal_fashn_v16')
  })
})
