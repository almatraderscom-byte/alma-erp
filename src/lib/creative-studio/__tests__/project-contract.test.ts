import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROJECT_FOLDER,
  erpStockRowsToProductOptions,
  normalizeProjectAssetLinkInput,
  normalizeProjectPatchInput,
  normalizeTagNames,
  ownedProjectWhere,
  slugifyAssetTag,
} from '@/lib/creative-studio/project-contract'

describe('CSE3 project ownership contract', () => {
  it('always scopes a direct project lookup to the authenticated owner', () => {
    expect(ownedProjectWhere('owner-a', 'project-1')).toEqual({
      id: 'project-1',
      ownerId: 'owner-a',
      archivedAt: null,
    })
    expect(ownedProjectWhere('owner-b', 'project-1')).not.toEqual(
      ownedProjectWhere('owner-a', 'project-1'),
    )
  })

  it('rounds ERP product snapshots to whole taka and permits clearing them', () => {
    expect(normalizeProjectPatchInput({
      productCode: ' AL-101 ',
      productName: ' Eid Panjabi ',
      productPriceBdt: 1299.6,
      productSourceImage: 'https://cdn.example/al-101.jpg',
    })).toMatchObject({
      productCode: 'AL-101',
      productName: 'Eid Panjabi',
      productPriceBdt: 1300,
    })
    expect(normalizeProjectPatchInput({
      productCode: null,
      productName: null,
      productPriceBdt: null,
      productSourceImage: null,
    })).toMatchObject({
      productCode: null,
      productName: null,
      productPriceBdt: null,
      productSourceImage: null,
    })
  })

  it('uses the read-only ERP stock master when the product master is empty', () => {
    expect(erpStockRowsToProductOptions([
      {
        sku: ' AL-475 ',
        product: 'Eid Panjabi',
        currentStock: 2,
        available: 1,
        sellValue: 3000,
        imageUrl: 'https://cdn.example/al-475.jpg',
      },
      {
        sku: 'AL-475',
        product: 'Eid Panjabi',
        currentStock: 3,
        available: 2,
        sellValue: 4500,
        imageUrl: null,
      },
    ])).toEqual([{
      code: 'AL-475',
      name: 'Eid Panjabi',
      priceBdt: 1500,
      sourceImage: 'https://cdn.example/al-475.jpg',
      available: 3,
    }])
  })
})

describe('CSE3 folders, tags and lineage inputs', () => {
  it('normalizes Bangla/English tags deterministically without duplicates', () => {
    expect(slugifyAssetTag(' ঈদ Offer 2026 ')).toBe('ঈদ-offer-2026')
    expect(normalizeTagNames([' Eid ', 'eid', 'ঈদ', 'ঈদ'])).toEqual(['Eid', 'ঈদ'])
  })

  it('creates a safe asset link with explicit source lineage', () => {
    expect(normalizeProjectAssetLinkInput({
      pendingActionId: 'job-1',
      tags: 'hero, approved, hero',
      sourceAssetIds: ['asset-1', 'asset-1', 'asset-2'],
      sourcePendingActionIds: ['legacy-job-1'],
    })).toEqual({
      pendingActionId: 'job-1',
      title: null,
      folder: DEFAULT_PROJECT_FOLDER,
      tags: ['hero', 'approved'],
      recipeId: null,
      sourceAssetIds: ['asset-1', 'asset-2'],
      sourcePendingActionIds: ['legacy-job-1'],
    })
  })
})
