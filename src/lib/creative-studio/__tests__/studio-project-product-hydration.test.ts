import { describe, expect, it, vi } from 'vitest'
import type { StudioProjectSummary } from '@/lib/creative-studio/project-contract'

vi.mock('@/agent/lib/catalog/product-images', () => ({
  listProductImages: vi.fn(async () => []),
}))

vi.mock('@/agent/lib/catalog/inventory-lookup', () => ({
  DEFAULT_CATALOG_BUSINESS: 'ALMA_LIFESTYLE',
}))

vi.mock('@/agent/lib/storage', () => ({
  agentStorageSignedUrls: vi.fn(async (paths: string[]) => Object.fromEntries(
    paths.map((path) => [path, `https://fresh.example/${path}?token=fresh`]),
  )),
}))

import { hydrateStudioProjectProducts } from '@/lib/creative-studio/studio-project-product-hydration'

const project: StudioProjectSummary = {
  id: 'project-1',
  name: 'Historical campaign',
  description: null,
  readonly: false,
  assetCount: 1,
  brandProfileId: 'brand-1',
  currentRecipeId: null,
  currentRecipe: null,
  product: {
    code: '133-KIDS',
    name: '133 Kids',
    priceBdt: 930,
    sourceImage: 'https://storage.example.supabase.co/storage/v1/object/sign/agent-files/product-images/alma-lifestyle/133-KIDS/1.jpg?token=expired',
    available: null,
  },
  defaultFolder: 'Unsorted',
  updatedAt: '2026-07-27T00:00:00.000Z',
}

describe('Studio project product hydration', () => {
  it('keeps project metadata while replacing expired URL lineage with a stable path and fresh preview', async () => {
    const [hydrated] = await hydrateStudioProjectProducts([project])
    expect(hydrated).toEqual({
      ...project,
      product: {
        ...project.product,
        sourceImage: 'product-images/alma-lifestyle/133-KIDS/1.jpg',
        previewImage: 'https://fresh.example/product-images/alma-lifestyle/133-KIDS/1.jpg?token=fresh',
      },
    })
  })
})
