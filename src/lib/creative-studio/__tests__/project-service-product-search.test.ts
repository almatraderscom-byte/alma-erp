import { describe, expect, it, vi } from 'vitest'

const imageOnly = {
  id: 'image-1',
  productCode: '133-KIDS',
  storagePath: 'product-images/alma-lifestyle/133-KIDS/1.jpg',
  url: 'https://expired.example/133-kids',
  isPrimary: true,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    lifestyleProduct: {
      findMany: vi.fn(async () => []),
    },
    lifestyleStockItem: {
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => []),
    },
    productImage: {
      findFirst: vi.fn(async () => imageOnly),
      findMany: vi.fn(async () => [imageOnly]),
    },
  },
}))

import { searchErpProducts } from '@/lib/creative-studio/project-service'

describe('Creative Studio historical product search', () => {
  it('keeps an exact image-backed SKU selectable after its active stock row is gone', async () => {
    await expect(searchErpProducts('133-KIDS')).resolves.toEqual([{
      code: '133-KIDS',
      name: '133-KIDS',
      priceBdt: 0,
      sourceImage: 'product-images/alma-lifestyle/133-KIDS/1.jpg',
      available: null,
    }])
  })
})
