import { describe, expect, it } from 'vitest'
import {
  hydrateLegacyStudioProduct,
  isLegacyStudioProductPath,
} from '@/lib/creative-studio/studio-product-source'

const legacyProduct = {
  code: '133-KIDS',
  name: '133 Kids',
  priceBdt: 1_250,
  sourceImage: '/agent/product-images/133-KIDS',
  available: 4,
}

describe('Studio product generation source', () => {
  it('turns an exact legacy catalog lookup into a stable paid-run path and preview URL', () => {
    expect(hydrateLegacyStudioProduct(legacyProduct, {
      storagePath: 'product-images/alma-lifestyle/133-KIDS/2.jpg',
      url: 'https://signed.example/133-kids',
    })).toEqual({
      ...legacyProduct,
      sourceImage: 'product-images/alma-lifestyle/133-KIDS/2.jpg',
      previewImage: 'https://signed.example/133-kids',
    })
  })

  it('fails closed when the legacy SKU has no healthy catalog image', () => {
    expect(hydrateLegacyStudioProduct(legacyProduct, null)).toEqual({
      ...legacyProduct,
      sourceImage: null,
      previewImage: null,
    })
  })

  it('does not rewrite a stable project source', () => {
    const stable = { ...legacyProduct, sourceImage: 'product-images/133-KIDS/2.jpg' }
    expect(isLegacyStudioProductPath(stable.sourceImage)).toBe(false)
    expect(hydrateLegacyStudioProduct(stable, {
      storagePath: 'product-images/other.jpg',
      url: 'https://signed.example/other',
    })).toBe(stable)
  })
})
