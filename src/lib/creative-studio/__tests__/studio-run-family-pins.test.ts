import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  issueStudioRunEstimate,
  verifyStudioRunEstimateReceipt,
  type StudioRunFamilyModelPin,
} from '@/lib/creative-studio/studio-run-authorization'
import {
  assertStudioRunFamilyPayloadReferences,
} from '@/lib/creative-studio/studio-run-execution-gate'

const pins: StudioRunFamilyModelPin[] = [
  {
    role: 'father',
    modelId: 'model-father',
    modelImagePath: 'models/father.jpg',
    sourceImagePath: 'avatars/father-canonical.jpg',
    avatarSheetPath: 'avatars/father-sheet.jpg',
    modelName: 'Father',
  },
  {
    role: 'son',
    modelId: 'model-son',
    modelImagePath: 'models/son.jpg',
    sourceImagePath: 'models/son.jpg',
    modelName: 'Son',
  },
]

function signedClaims() {
  const estimate = issueStudioRunEstimate({
    scope: {
      actorUserId: 'owner-1',
      ownerId: 'owner-1',
      role: 'owner',
      brandProfileId: 'brand-1',
      projectId: 'project-1',
      productId: 'product-1',
      sourceAssetIds: ['asset-1'],
      familyModelPins: pins,
    },
    request: {
      mode: 'try_on',
      familyPreset: 'father_son',
      familyModelPins: pins,
    },
    selection: {
      mode: 'try_on',
      architecture: 'advanced',
      provider: 'fashn',
      model: 'tryon-max',
      providers: ['fashn'],
      models: ['tryon-max'],
      plan: ['family_chain'],
      paidAttemptLimit: 2,
    },
    estimateBdt: 100,
    requestedCapBdt: 100,
  })
  return verifyStudioRunEstimateReceipt(estimate.receipt, {
    phase: 'execute',
  })
}

beforeEach(() => {
  process.env.CREATIVE_STUDIO_RUN_CONFIRMATION_SECRET =
    'test-only-studio-run-confirmation-secret'
})

afterEach(() => {
  delete process.env.CREATIVE_STUDIO_RUN_CONFIRMATION_SECRET
})

describe('signed family model pins', () => {
  it('accepts only the exact saved-model/avatar references in a family chain', () => {
    const claims = signedClaims()
    const payload = {
      familyPreset: 'father_son',
      familyChain: {
        variant: 'father_son',
        adultRole: 'father',
        adultModelPath: 'avatars/father-canonical.jpg',
        childRole: 'son',
        childModelPath: 'models/son.jpg',
      },
    }
    expect(() =>
      assertStudioRunFamilyPayloadReferences(claims, payload),
    ).not.toThrow()
    expect(() => assertStudioRunFamilyPayloadReferences(claims, {
      ...payload,
      familyChain: {
        ...payload.familyChain,
        childModelPath: 'models/other-brand-child.jpg',
      },
    })).toThrowError(expect.objectContaining({
      code: 'run_family_model_reference_tampered',
    }))
  })

  it('binds xAI saved-model source ids and paths to the same pins', () => {
    const claims = signedClaims()
    const payload = {
      familyPreset: 'father_son',
      referenceContract: {
        bindings: [
          {
            role: 'person',
            source: 'saved_model',
            sourceId: 'model-father',
            path: 'avatars/father-sheet.jpg',
          },
          {
            role: 'person',
            source: 'saved_model',
            sourceId: 'model-son',
            path: 'models/son.jpg',
          },
        ],
      },
    }
    expect(() =>
      assertStudioRunFamilyPayloadReferences(claims, payload),
    ).not.toThrow()
    expect(() => assertStudioRunFamilyPayloadReferences(claims, {
      ...payload,
      referenceContract: {
        bindings: [{
          role: 'person',
          source: 'saved_model',
          sourceId: 'model-son',
          path: 'avatars/father-sheet.jpg',
        }],
      },
    })).toThrowError(expect.objectContaining({
      code: 'run_family_model_reference_tampered',
    }))
  })

  it('fails closed when a required implicit family role is absent', () => {
    const claims = signedClaims()
    claims.scope.familyModelPins = pins.filter((pin) => pin.role === 'father')
    expect(() => assertStudioRunFamilyPayloadReferences(claims, {
      familyPreset: 'father_son',
    })).toThrowError(expect.objectContaining({
      code: 'run_family_model_pin_missing',
    }))
  })

  it('does not misclassify an explicit solo saved model as an implicit family reference', () => {
    const claims = signedClaims()
    expect(() => assertStudioRunFamilyPayloadReferences(claims, {
      studioMode: 'try_on',
      referenceContract: {
        bindings: [{
          role: 'person',
          source: 'saved_model',
          sourceId: 'explicit-solo-model',
          path: 'models/explicit-solo.jpg',
        }],
      },
    })).not.toThrow()
  })
})
