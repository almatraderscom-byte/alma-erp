import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  modelPaths: new Map<string, { imagePath: string; role: string }>(),
  referenceScopes: new Map<string, { referenceKind: 'product' | 'model'; sourcePath: string }>(),
  scopeChecks: [] as Array<{
    id: string
    legacyModelActor?: { userId: string; erpRole: string }
  }>,
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: async () => ({
        id: 'owner-1',
        name: 'Owner',
        email: 'owner@example.com',
        role: 'SUPER_ADMIN',
      }),
    },
    creativeProject: {
      findFirst: async () => ({ id: 'project-1' }),
    },
    agentBrandModel: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.modelPaths.get(where.id) ?? null,
    },
  },
}))

vi.mock('@/lib/creative-studio/studio-access', () => ({
  StudioAccessError: class StudioAccessError extends Error {
    code: string
    status: number
    constructor(code: string, status: number) {
      super(code)
      this.code = code
      this.status = status
    }
  },
  requireStudioBrandAccess: async () => ({
    ownerId: 'owner-1',
    role: 'owner',
    approvalSpendThresholdBdt: 500,
  }),
  assertStudioSpendAllowed: () => undefined,
}))

vi.mock('@/lib/creative-studio/studio-resource-scope', () => ({
  assertStudioResourceScope: async (
    kind: string,
    id: string,
    _expected: unknown,
    options?: { legacyModelActor?: { userId: string; erpRole: string } },
  ) => {
    state.scopeChecks.push({ id, legacyModelActor: options?.legacyModelActor })
    if (kind === 'reference') {
      return state.referenceScopes.get(id) ?? null
    }
    if (!options?.legacyModelActor) {
      throw Object.assign(new Error('model_scope_mismatch'), { status: 403 })
    }
    return { version: 1 }
  },
}))

vi.mock('@/lib/creative-studio/taste', () => ({
  readKv: async () => null,
}))

import {
  issueStudioRunEstimate,
  verifyStudioRunEstimateReceipt,
  type StudioRunFamilyModelPin,
} from '@/lib/creative-studio/studio-run-authorization'
import {
  assertStudioRunExecutionGate,
} from '@/lib/creative-studio/studio-run-execution-gate'
import {
  studioRunAuthorizedJobFields,
  withStudioRunExecutionContext,
} from '@/lib/creative-studio/studio-run-context'

const pins: StudioRunFamilyModelPin[] = [
  {
    role: 'father',
    modelId: 'model-father',
    modelImagePath: 'models/father.jpg',
    sourceImagePath: 'avatars/father.jpg',
    modelName: 'Father',
  },
  {
    role: 'son',
    modelId: 'model-son',
    modelImagePath: 'models/son.jpg',
    sourceImagePath: 'avatars/son.jpg',
    modelName: 'Son',
  },
]

beforeEach(() => {
  process.env.CREATIVE_STUDIO_RUN_CONFIRMATION_SECRET =
    'test-only-studio-run-confirmation-secret'
  state.modelPaths.clear()
  state.referenceScopes.clear()
  state.scopeChecks.length = 0
  for (const pin of pins) {
    state.modelPaths.set(pin.modelId, {
      imagePath: pin.modelImagePath,
      role: pin.role,
    })
  }
})

afterEach(() => {
  delete process.env.CREATIVE_STUDIO_RUN_CONFIRMATION_SECRET
})

describe('family pins at the execution boundary', () => {
  it('revalidates the pinned model rows and rejects a reassigned path before execution', async () => {
    const estimate = issueStudioRunEstimate({
      scope: {
        actorUserId: 'owner-1',
        ownerId: 'owner-1',
        role: 'owner',
        brandProfileId: 'brand-1',
        projectId: 'project-1',
        productId: 'AL-101',
        sourceAssetIds: ['asset-1'],
        familyModelPins: pins,
      },
      request: {
        mode: 'try_on',
        familyPreset: 'father_son',
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
    const claims = verifyStudioRunEstimateReceipt(estimate.receipt, {
      phase: 'execute',
    })
    const authorized = await withStudioRunExecutionContext({
      claims,
      receipt: estimate.receipt,
      idempotencyKey: `family-execution:${claims.receiptId}`,
    }, async () => studioRunAuthorizedJobFields({
      provider: 'garment_prep',
      familyPreset: 'father_son',
      familyChain: {
        variant: 'father_son',
        adultRole: 'father',
        adultModelPath: 'avatars/father.jpg',
        childRole: 'son',
        childModelPath: 'avatars/son.jpg',
      },
    }))

    await expect(assertStudioRunExecutionGate({
      receipt: estimate.receipt,
      payload: authorized.payload,
      expectedClaims: claims,
      checkProviderAvailability: false,
    })).resolves.toEqual(expect.objectContaining({
      receiptId: claims.receiptId,
    }))
    expect(state.scopeChecks).toEqual([
      {
        id: 'model-father',
        legacyModelActor: { userId: 'owner-1', erpRole: 'SUPER_ADMIN' },
      },
      {
        id: 'model-son',
        legacyModelActor: { userId: 'owner-1', erpRole: 'SUPER_ADMIN' },
      },
    ])

    state.modelPaths.set('model-son', {
      imagePath: 'models/reassigned-son.jpg',
      role: 'son',
    })
    await expect(assertStudioRunExecutionGate({
      receipt: estimate.receipt,
      payload: authorized.payload,
      expectedClaims: claims,
      checkProviderAvailability: false,
    })).rejects.toMatchObject({
      message: 'studio_run_family_model_changed',
      status: 409,
    })
  })

  it('revalidates immutable uploaded-reference pins before a paid job executes', async () => {
    state.referenceScopes.set('reference-product', {
      referenceKind: 'product',
      sourcePath: 'references/product.jpg',
    })
    const estimate = issueStudioRunEstimate({
      scope: {
        actorUserId: 'owner-1',
        ownerId: 'owner-1',
        role: 'owner',
        brandProfileId: 'brand-1',
        projectId: 'project-1',
        productId: 'AL-101',
        sourceAssetIds: [],
        referencePins: [{
          id: 'reference-product',
          kind: 'product',
          sourcePath: 'references/product.jpg',
        }],
      },
      request: {
        mode: 'try_on',
        productImagePath: 'references/product.jpg',
      },
      selection: {
        mode: 'try_on',
        architecture: 'advanced',
        provider: 'fashn',
        model: 'tryon-max',
        providers: ['fashn'],
        models: ['tryon-max'],
        plan: ['single_try_on'],
        paidAttemptLimit: 1,
      },
      estimateBdt: 25,
      requestedCapBdt: 25,
    })
    const claims = verifyStudioRunEstimateReceipt(estimate.receipt, {
      phase: 'execute',
    })
    const authorized = await withStudioRunExecutionContext({
      claims,
      receipt: estimate.receipt,
      idempotencyKey: `reference-execution:${claims.receiptId}`,
    }, async () => studioRunAuthorizedJobFields({
      provider: 'garment_prep',
      productImagePath: 'references/product.jpg',
    }))

    await expect(assertStudioRunExecutionGate({
      receipt: estimate.receipt,
      payload: authorized.payload,
      expectedClaims: claims,
      checkProviderAvailability: false,
    })).resolves.toEqual(expect.objectContaining({
      receiptId: claims.receiptId,
    }))

    state.referenceScopes.set('reference-product', {
      referenceKind: 'product',
      sourcePath: 'references/replaced.jpg',
    })
    await expect(assertStudioRunExecutionGate({
      receipt: estimate.receipt,
      payload: authorized.payload,
      expectedClaims: claims,
      checkProviderAvailability: false,
    })).rejects.toMatchObject({
      message: 'studio_run_reference_changed',
      status: 409,
    })
  })
})
