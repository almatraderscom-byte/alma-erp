import { describe, expect, it } from 'vitest'
import { STUDIO_MODES } from '../constants'
import {
  ADVANCED_ENGINE_CAPABILITIES,
  GENERIC_IMAGE_MODELS,
  assertAdvancedEngineMode,
  buildDirectFashnInputs,
  genericImageProvider,
  getAdvancedModeCapability,
  makeReferenceContract,
  normalizeGenericImageModels,
  referenceSummary,
  estimateDirectFashnCostUsd,
  validateAdvancedControlValues,
} from '../advanced-image-capabilities'

describe('CSE-A — exhaustive engine × Advanced-mode capability contract', () => {
  it('declares an explicit supported or unsupported verdict for every combination', () => {
    for (const engine of ADVANCED_ENGINE_CAPABILITIES) {
      for (const mode of STUDIO_MODES) {
        const supported = getAdvancedModeCapability(engine.engine, mode.id)
        if (supported) {
          expect(supported.fidelity).not.toBe('unsupported')
          expect(supported.maxReferences).toBeGreaterThanOrEqual(supported.required.length)
        } else {
          expect(() => assertAdvancedEngineMode(engine.engine, mode.id))
            .toThrow(`engine_mode_unsupported:${engine.engine}:${mode.id}`)
        }
      }
    }
  })

  it('never advertises Fal VTON as Product→Model', () => {
    expect(getAdvancedModeCapability('fal_fashn_v16', 'product_to_model')).toBeNull()
    expect(getAdvancedModeCapability('fal_idm_vton', 'product_to_model')).toBeNull()
    expect(getAdvancedModeCapability('fal_fashn_v16', 'try_on')?.fidelity).toBe('purpose_built')
  })

  it('distinguishes purpose-built FASHN from general xAI/generic guidance', () => {
    expect(getAdvancedModeCapability('fashn', 'product_to_model')?.fidelity).toBe('purpose_built')
    expect(getAdvancedModeCapability('xai_imagine', 'product_to_model')?.fidelity).toBe('identity_guided')
    expect(getAdvancedModeCapability('gemini', 'try_on')?.fidelity).toBe('identity_guided')
  })
})

describe('CSE-A — exact direct FASHN adapter fields', () => {
  it('maps Product→Model selected person to face_reference, never model_image', () => {
    expect(buildDirectFashnInputs({
      mode: 'product_to_model',
      productImagePath: 'product.jpg',
      modelImagePath: 'selected-person.jpg',
    })).toEqual({
      product_image: 'product.jpg',
      face_reference: 'selected-person.jpg',
      face_reference_mode: 'match_reference',
    })
  })

  it('keeps Try-On on the purpose-built product_image + model_image pair', () => {
    expect(buildDirectFashnInputs({
      mode: 'try_on',
      productImagePath: 'product.jpg',
      modelImagePath: 'person.jpg',
    })).toEqual({ product_image: 'product.jpg', model_image: 'person.jpg' })
  })

  it('maps every other Advanced FASHN mode to documented named fields', () => {
    expect(buildDirectFashnInputs({
      mode: 'model_swap',
      sourceImagePath: 'fashion-source.jpg',
      modelImagePath: 'target-person.jpg',
    })).toEqual({
      model_image: 'fashion-source.jpg',
      face_reference: 'target-person.jpg',
      face_reference_mode: 'match_reference',
    })
    expect(buildDirectFashnInputs({
      mode: 'face_to_model',
      modelImagePath: 'face.jpg',
    })).toEqual({ face_image: 'face.jpg' })
    expect(buildDirectFashnInputs({
      mode: 'edit',
      sourceImagePath: 'source.jpg',
      productImagePath: 'context.jpg',
    })).toEqual({ image: 'source.jpg', image_context: 'context.jpg' })
  })

  it('includes the Product→Model/Swap face-reference surcharge in the approval estimate', () => {
    expect(estimateDirectFashnCostUsd({
      resolution: '2k',
      generationMode: 'balanced',
      hasFaceReference: true,
    })).toBeCloseTo(0.45)
    expect(estimateDirectFashnCostUsd({
      resolution: '1k',
      generationMode: 'fast',
      hasFaceReference: false,
    })).toBeCloseTo(0.075)
  })
})

describe('CSE-A — immutable reference contract', () => {
  it('captures selected product and saved person identities in order', () => {
    const contract = makeReferenceContract({
      mode: 'product_to_model',
      requestedEngine: 'xai_imagine',
      actualModel: 'grok-imagine-image-quality',
      bindings: [
        { role: 'product', path: 'products/p1.jpg', source: 'uploaded', required: true },
        { role: 'person', path: 'avatars/m1.png', source: 'saved_model', sourceId: 'm1', required: false },
      ],
    })
    expect(contract.bindings.map((binding) => binding.role)).toEqual(['product', 'person'])
    expect(contract.bindings[1].sourceId).toBe('m1')
    expect(referenceSummary(contract)).toEqual({ expectedCount: 2, requiredRoles: ['product'] })
  })

  it('fails closed for missing required references and capacity overflow', () => {
    expect(() => makeReferenceContract({
      mode: 'try_on',
      requestedEngine: 'xai_imagine',
      actualModel: 'grok-imagine-image-quality',
      bindings: [{ role: 'product', path: 'p.jpg', source: 'uploaded', required: true }],
    })).toThrow('person_image_required')

    expect(() => makeReferenceContract({
      mode: 'try_on',
      requestedEngine: 'fal_fashn_v16',
      actualModel: 'fal-ai/fashn/tryon/v1.6',
      bindings: [
        { role: 'person', path: 'm.jpg', source: 'uploaded', required: true },
        { role: 'product', path: 'p.jpg', source: 'uploaded', required: true },
        { role: 'identity_sheet', path: 's.jpg', source: 'derived', required: false },
      ],
    })).toThrow('reference_limit_exceeded')
  })
})

describe('CSE-A — exact generic model snapshot allowlist', () => {
  it('normalizes only worker-supported models', () => {
    for (const model of GENERIC_IMAGE_MODELS) {
      const normalized = normalizeGenericImageModels(JSON.stringify({ standard: model, pro: model }))
      expect(normalized).toEqual({ standard: model, pro: model })
    }
    expect(normalizeGenericImageModels('{"standard":"injected","pro":"also-injected"}')).toEqual({
      standard: 'gemini-3.1-flash-image',
      pro: 'gemini-3-pro-image',
    })
    expect(normalizeGenericImageModels('{broken')).toEqual({
      standard: 'gemini-3.1-flash-image',
      pro: 'gemini-3-pro-image',
    })
  })

  it('attributes actual generic providers truthfully', () => {
    expect(genericImageProvider('gemini-3-pro-image')).toBe('gemini')
    expect(genericImageProvider('gpt-image-2')).toBe('openai')
    expect(genericImageProvider('seedream-5.0-pro')).toBe('fal')
  })
})

describe('CSE-A — Advanced control guards', () => {
  it('accepts every current UI aspect/resolution/mode/count value', () => {
    for (const aspectRatio of ['4:5', '1:1', '9:16', '16:9']) {
      for (const resolution of ['1k', '2k', '4k']) {
        for (const generationMode of ['fast', 'balanced', 'quality']) {
          expect(() => validateAdvancedControlValues({
            mode: 'product_to_model',
            engine: 'xai_imagine',
            aspectRatio,
            resolution,
            generationMode,
            numImages: 4,
          })).not.toThrow()
        }
      }
    }
  })

  it('blocks crafted values and FASHN Face→Model landscape before spend', () => {
    expect(() => validateAdvancedControlValues({ mode: 'try_on', aspectRatio: '21:9' }))
      .toThrow('aspect_ratio_unsupported')
    expect(() => validateAdvancedControlValues({ mode: 'try_on', resolution: '8k' }))
      .toThrow('resolution_unsupported')
    expect(() => validateAdvancedControlValues({ mode: 'try_on', generationMode: 'turbo' }))
      .toThrow('generation_mode_unsupported')
    expect(() => validateAdvancedControlValues({ mode: 'try_on', numImages: 99 }))
      .toThrow('num_images_unsupported')
    expect(() => validateAdvancedControlValues({
      mode: 'face_to_model',
      engine: 'fashn',
      aspectRatio: '16:9',
    })).toThrow('aspect_ratio_unsupported:fashn:face_to_model:16:9')
  })
})
