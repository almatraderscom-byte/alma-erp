import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/creative-studio/single-pipeline', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/creative-studio/single-pipeline')
  >()
  return {
    ...actual,
    readPipelineMode: vi.fn(async () => 'production'),
  }
})

vi.mock('@/lib/creative-studio/taste', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/creative-studio/taste')
  >()
  return {
    ...actual,
    readKv: vi.fn(async () => null),
  }
})

vi.mock('@/lib/tryon/model-library', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/tryon/model-library')
  >()
  return {
    ...actual,
    resolveModel: vi.fn(async () => ({
      id: 'model-1',
      name: 'Model',
      imagePath: 'models/model-1.png',
    })),
    getModelByRole: vi.fn(async () => null),
  }
})

vi.mock('@/lib/fashn/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fashn/client')>()
  return {
    ...actual,
    isFashnConfigured: vi.fn(() => false),
  }
})

vi.mock('@/lib/tryon/art-director', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tryon/art-director')>()
  return {
    ...actual,
    getOrClassifyGarment: vi.fn(async () => ({
      garmentType: 'panjabi',
      dominantColors: ['rose'],
      fabricGuess: 'cotton',
      embroideryZones: ['collar'],
      hasContrastBottom: false,
      suggestedRole: 'single',
      notes: '',
    })),
  }
})

import { issueStudioRunEstimate } from '@/lib/creative-studio/studio-run-authorization'
import { buildStudioRunPlan } from '@/lib/creative-studio/studio-run-plan'
import { getModelByRole } from '@/lib/tryon/model-library'
import { getOrClassifyGarment } from '@/lib/tryon/art-director'
import { isFashnConfigured } from '@/lib/fashn/client'
import { readKv } from '@/lib/creative-studio/taste'

beforeEach(() => {
  vi.mocked(getModelByRole).mockClear()
  vi.mocked(getOrClassifyGarment).mockClear()
  process.env.GEMINI_API_KEY = 'test-gemini-key'
  vi.mocked(readKv).mockResolvedValue(null)
  process.env.CREATIVE_STUDIO_RUN_CONFIRMATION_SECRET =
    'test-only-studio-run-confirmation-secret'
})

afterEach(() => {
  delete process.env.GEMINI_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.CREATIVE_STUDIO_RUN_CONFIRMATION_SECRET
})

describe('Studio run aggregate plan cap', () => {
  it('resolves the guided-image lane to the configured GPT Image 2 provider', async () => {
    delete process.env.GEMINI_API_KEY
    process.env.OPENAI_API_KEY = 'test-openai-key'
    vi.mocked(readKv).mockImplementation(async (key) => (
      key === 'cs_image_models'
        ? JSON.stringify({ standard: 'gpt-image-2', pro: 'gpt-image-2' })
        : null
    ))

    const plan = await buildStudioRunPlan({
      mode: 'try_on',
      provider: 'gemini',
      vtonEngine: 'gemini',
      modelId: 'model-1',
      modelImagePath: 'models/model-1.png',
      productImagePath: 'products/product-1.png',
      generationMode: 'fast',
      resolution: '1k',
      pipelineMode: 'preview',
    })

    expect(plan.selection.provider).toBe('openai')
    expect(plan.selection.model).toBe('gpt-image-2')
    expect(plan.selection.providers).toEqual(['openai'])
    expect(plan.pinned.genericImageModel).toBe('gpt-image-2')
  })

  it('pins an explicit V4 quality policy instead of mutable KV state', async () => {
    const base = {
      auto: true,
      mode: 'product_to_model' as const,
      modelId: 'model-1',
      productImagePath: 'products/product-1.png',
    }
    expect((await buildStudioRunPlan({ ...base, pipelineMode: 'preview' })).selection.paidAttemptLimit).toBe(1)
    expect((await buildStudioRunPlan({ ...base, pipelineMode: 'production' })).selection.paidAttemptLimit).toBe(3)
  })

  it('blocks a Kids project with an unlabeled/adult identity before estimate', async () => {
    await expect(buildStudioRunPlan({
      auto: true,
      mode: 'try_on',
      modelId: 'model-1',
      productImagePath: 'products/133.png',
      productName: '133 KIDS',
      pipelineMode: 'production',
    })).rejects.toThrow('kids_product_requires_labeled_child_model')
  })

  it('blocks an ambiguous family collage before issuing an Auto estimate', async () => {
    vi.mocked(getOrClassifyGarment).mockResolvedValueOnce({
      garmentType: 'family_matching_set',
      dominantColors: ['rose'],
      fabricGuess: 'cotton',
      embroideryZones: ['collar'],
      hasContrastBottom: true,
      suggestedRole: 'family',
      notes: 'multiple role garments',
    })
    await expect(buildStudioRunPlan({
      auto: true,
      mode: 'try_on',
      modelId: 'model-1',
      productImagePath: 'products/family-collage.png',
    })).rejects.toThrow('family_product_requires_role_crop')
  })

  it('prices Auto family pairs only from server-pinned identities', async () => {
    const familyModelPins = ['father', 'mother', 'son', 'daughter'].map((role) => ({
      role: role as 'father' | 'mother' | 'son' | 'daughter',
      modelId: `model-${role}`,
      modelImagePath: `models/${role}.jpg`,
      sourceImagePath: `avatars/${role}.jpg`,
      modelName: role,
    }))
    const plan = await buildStudioRunPlan({
      auto: true,
      mode: 'product_to_model',
      modelId: 'model-1',
      productImagePath: 'products/product-1.png',
      includeFamily: true,
      familyModelPins,
    })

    expect(plan.selection.plan).toContain('3x_auto_family_guided_image')
    expect(getModelByRole).not.toHaveBeenCalled()
  })

  it('prices an explicit father-son FASHN request as the orchestrated family chain', async () => {
    vi.mocked(isFashnConfigured).mockReturnValueOnce(true)
    const plan = await buildStudioRunPlan({
      mode: 'product_to_model',
      provider: 'fashn',
      vtonEngine: 'fashn',
      familyPreset: 'father_son',
      productImagePath: 'products/matching-panjabi.png',
      generationMode: 'quality',
      pipelineMode: 'production',
    })

    expect(plan.selection.provider).toBe('fashn')
    expect(plan.selection.models).toContain('tryon-max')
    expect(plan.selection.plan).toEqual([
      'garment_prep',
      'adult_vton',
      'child_vton',
      'pair_merge',
    ])
    expect(plan.pinned.chainVtonEngine).toBe('fashn')
  })

  it('prices every production Auto reel attempt into the signed estimate', async () => {
    const baseInput = {
      auto: true,
      mode: 'product_to_model' as const,
      modelId: 'model-1',
      productImagePath: 'products/product-1.png',
      includeFamily: false,
    }
    const withoutReel = await buildStudioRunPlan(baseInput)
    const withReel = await buildStudioRunPlan({
      ...baseInput,
      includeReel: true,
    })

    expect(withReel.selection.paidAttemptLimit).toBe(3)
    expect(withReel.estimateUsd - withoutReel.estimateUsd).toBeCloseTo(
      6 * 0.15 * withReel.selection.paidAttemptLimit,
      8,
    )
    const signed = issueStudioRunEstimate({
      scope: {
        actorUserId: 'owner-1',
        ownerId: 'owner-1',
        role: 'owner',
        brandProfileId: 'brand-1',
        projectId: 'project-1',
        productId: null,
        sourceAssetIds: ['asset-1'],
      },
      request: baseInput,
      selection: withReel.selection,
      estimateBdt: withReel.estimateBdt,
      requestedCapBdt: withReel.estimateBdt,
      now: new Date('2026-07-26T06:00:00.000Z'),
    })
    expect(signed.estimateBdt).toBe(withReel.estimateBdt)
    expect(signed.maxCostBdt).toBe(withReel.estimateBdt)
  })
})
