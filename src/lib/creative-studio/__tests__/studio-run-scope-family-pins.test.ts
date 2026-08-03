import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  roleLookups: [] as string[],
  scopedModels: [] as string[],
  legacyProduct: false,
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
        productSourceImage: state.legacyProduct
          ? '/agent/product-images/AL-101'
          : 'products/al-101.jpg',
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
    kind: string,
    id: string,
    expected: Record<string, unknown>,
  ) => {
    expect(expected).toEqual({
      ownerId: 'owner-1',
      brandProfileId: 'brand-1',
      projectId: 'project-1',
    })
    state.scopedModels.push(id)
    if (kind === 'reference') {
      return id === 'product-reference'
        ? {
            version: 1,
            referenceKind: 'product',
            sourcePath: 'references/product.jpg',
          }
        : {
            version: 1,
            referenceKind: 'model',
            sourcePath: 'references/model.jpg',
          }
    }
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

vi.mock('@/agent/lib/catalog/product-images', () => ({
  listProductImages: async (code: string) => code === 'AL-101'
    ? [{ storagePath: 'product-images/alma-lifestyle/AL-101/1.jpg', url: 'https://signed.example/al-101' }]
    : [],
}))

vi.mock('@/agent/lib/catalog/inventory-lookup', () => ({
  DEFAULT_CATALOG_BUSINESS: 'ALMA_LIFESTYLE',
}))

import { resolveScopedStudioRun } from '@/lib/creative-studio/studio-run-scope'

beforeEach(() => {
  state.roleLookups.length = 0
  state.scopedModels.length = 0
  state.legacyProduct = false
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

  it('pins uploaded product and model paths to the current project scope', async () => {
    const scoped = await resolveScopedStudioRun({
      userId: 'owner-1',
      name: 'Owner',
      email: 'owner@example.com',
      erpRole: 'OWNER',
    }, {
      mode: 'try_on',
      brandProfileId: 'brand-1',
      projectId: 'project-1',
      productId: 'AL-101',
      productImagePath: 'references/product.jpg',
      modelImagePath: 'references/model.jpg',
      productReferenceId: 'product-reference',
      modelReferenceId: 'model-reference',
    })

    expect(scoped.scope.referencePins).toEqual([
      {
        id: 'product-reference',
        kind: 'product',
        sourcePath: 'references/product.jpg',
      },
      {
        id: 'model-reference',
        kind: 'model',
        sourcePath: 'references/model.jpg',
      },
    ])
    expect(scoped.request).toEqual(expect.objectContaining({
      productReferenceId: 'product-reference',
      modelReferenceId: 'model-reference',
    }))
  })

  it('accepts only the healthy catalog object resolved from a legacy project SKU', async () => {
    state.legacyProduct = true
    const scoped = await resolveScopedStudioRun({
      userId: 'owner-1',
      name: 'Owner',
      email: 'owner@example.com',
      erpRole: 'OWNER',
    }, {
      mode: 'try_on',
      brandProfileId: 'brand-1',
      projectId: 'project-1',
      productId: 'AL-101',
      productImagePath: 'product-images/alma-lifestyle/AL-101/1.jpg',
    })

    expect(scoped.request.productImagePath).toBe('product-images/alma-lifestyle/AL-101/1.jpg')

    await expect(resolveScopedStudioRun({
      userId: 'owner-1',
      name: 'Owner',
      email: 'owner@example.com',
      erpRole: 'OWNER',
    }, {
      mode: 'try_on',
      brandProfileId: 'brand-1',
      projectId: 'project-1',
      productId: 'AL-101',
      productImagePath: '/agent/product-images/AL-101',
    })).rejects.toThrow('source_lineage_scope_mismatch')
  })
})
