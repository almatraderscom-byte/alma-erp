import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  roleLookups: [] as string[],
  scopedModels: [] as string[],
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    creativeProject: {
      findFirst: async () => ({
        id: 'project-1',
        ownerId: 'owner-1',
        brandProfileId: 'brand-1',
        archivedAt: null,
        productCode: 'AL-101',
        productSourceImage: 'products/al-101.jpg',
      }),
    },
    creativeProjectAsset: {
      findMany: async () => [],
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
    _kind: string,
    id: string,
    expected: Record<string, unknown>,
  ) => {
    expect(expected).toEqual({
      ownerId: 'owner-1',
      brandProfileId: 'brand-1',
      projectId: 'project-1',
    })
    state.scopedModels.push(id)
    return { version: 1 }
  },
}))

const models = {
  father: {
    id: 'model-father',
    name: 'Pinned father',
    imagePath: 'models/father.jpg',
    isDefault: true,
    role: 'father',
  },
  son: {
    id: 'model-son',
    name: 'Pinned son',
    imagePath: 'models/son.jpg',
    isDefault: false,
    role: 'son',
  },
} as const

vi.mock('@/lib/tryon/model-library', () => ({
  getModelByRole: async (role: keyof typeof models) => {
    state.roleLookups.push(role)
    return models[role] ?? null
  },
}))

vi.mock('@/lib/tryon/model-avatar', () => ({
  resolvePersonRef: async (model: { id: string; imagePath: string }) => ({
    path: `avatars/${model.id}-canonical.jpg`,
    sheetPath: `avatars/${model.id}-sheet.jpg`,
  }),
}))

import { resolveScopedStudioRun } from '@/lib/creative-studio/studio-run-scope'

beforeEach(() => {
  state.roleLookups.length = 0
  state.scopedModels.length = 0
})

describe('server-derived family run scope', () => {
  it('replaces caller family claims with exact accessible model/avatar pins', async () => {
    const scoped = await resolveScopedStudioRun({
      userId: 'owner-1',
      name: 'Owner',
      email: 'owner@example.com',
      erpRole: 'OWNER',
    }, {
      mode: 'try_on',
      familyPreset: 'father_son',
      brandProfileId: 'brand-1',
      projectId: 'project-1',
      productId: 'AL-101',
      productImagePath: 'products/al-101.jpg',
      familyModelPins: [{
        role: 'father',
        modelId: 'attacker-model',
        modelImagePath: 'private/other-brand.jpg',
        sourceImagePath: 'private/other-brand.jpg',
        modelName: 'Caller claim',
      }],
    })

    expect(state.roleLookups).toEqual(['father', 'son'])
    expect(state.scopedModels).toEqual(['model-father', 'model-son'])
    expect(scoped.request.familyModelPins).toEqual([
      {
        role: 'father',
        modelId: 'model-father',
        modelImagePath: 'models/father.jpg',
        sourceImagePath: 'avatars/model-father-canonical.jpg',
        avatarSheetPath: 'avatars/model-father-sheet.jpg',
        modelName: 'Pinned father',
      },
      {
        role: 'son',
        modelId: 'model-son',
        modelImagePath: 'models/son.jpg',
        sourceImagePath: 'avatars/model-son-canonical.jpg',
        avatarSheetPath: 'avatars/model-son-sheet.jpg',
        modelName: 'Pinned son',
      },
    ])
    expect(scoped.scope.familyModelPins).toEqual(
      scoped.request.familyModelPins,
    )
  })
})
