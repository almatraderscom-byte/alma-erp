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

import { issueStudioRunEstimate } from '@/lib/creative-studio/studio-run-authorization'
import { buildStudioRunPlan } from '@/lib/creative-studio/studio-run-plan'
import { getModelByRole } from '@/lib/tryon/model-library'

beforeEach(() => {
  vi.mocked(getModelByRole).mockClear()
  process.env.GEMINI_API_KEY = 'test-gemini-key'
  process.env.CREATIVE_STUDIO_RUN_CONFIRMATION_SECRET =
    'test-only-studio-run-confirmation-secret'
})

afterEach(() => {
  delete process.env.GEMINI_API_KEY
  delete process.env.CREATIVE_STUDIO_RUN_CONFIRMATION_SECRET
})

describe('Studio run aggregate plan cap', () => {
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
