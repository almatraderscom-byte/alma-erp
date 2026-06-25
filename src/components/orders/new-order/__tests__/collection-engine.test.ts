import { describe, it, expect } from 'vitest'
import type { StockItem } from '@/types'
import { matchCollectionStock, detectCollectionFromStock } from '../collection-engine'

function stock(partial: Partial<StockItem> & Pick<StockItem, 'sku' | 'size'>): StockItem {
  return {
    product: partial.product ?? partial.sku,
    category: '', color: '',
    opening: 0, purchased: 0, sold: 0, returned: 0, damaged: 0, reserved: 0,
    current_stock: 100, available: 100, reorder_level: 5,
    status: 'IN STOCK', stock_value: 0, sell_value: 0, potential_profit: 0,
    active: true, archived: false,
    ...partial,
  } as StockItem
}

// Mirrors the real production inventory shape: consolidated KIDS/ADULT pools for MEN,
// ORNA / TWO PIECE / THREE PIECE pools for WOMEN, and one row per SINGLE product.
const STOCK: StockItem[] = [
  stock({ sku: '133-KIDS', size: 'KIDS', collectionCode: '133', collectionType: 'MEN', sizeGroup: 'KIDS' }),
  stock({ sku: '133-ADULT', size: 'ADULT', collectionCode: '133', collectionType: 'MEN', sizeGroup: 'ADULT' }),
  stock({ sku: '133T-TWO-PIECE', size: 'TWO PIECE', collectionCode: '133T', collectionType: 'WOMEN', variantGroup: 'TWO PIECE' }),
  stock({ sku: '133T-ORNA', size: 'ORNA', collectionCode: '133T', collectionType: 'WOMEN', variantGroup: 'ORNA' }),
  stock({ sku: '501', size: '', product: 'Money counter', collectionCode: '501', collectionType: 'SINGLE' }),
]

describe('matchCollectionStock', () => {
  it('MEN: a kids numeric size (16-36) resolves to the KIDS pool sku', () => {
    const c = detectCollectionFromStock(STOCK, '133')!
    expect(c.collectionType).toBe('MEN')
    expect(matchCollectionStock(STOCK, c, { size: '20' })?.sku).toBe('133-KIDS')
    expect(matchCollectionStock(STOCK, c, { size: '36' })?.sku).toBe('133-KIDS')
  })

  it('MEN: an adult numeric size (38-54) resolves to the ADULT pool sku', () => {
    const c = detectCollectionFromStock(STOCK, '133')!
    expect(matchCollectionStock(STOCK, c, { size: '42' })?.sku).toBe('133-ADULT')
    expect(matchCollectionStock(STOCK, c, { size: '54' })?.sku).toBe('133-ADULT')
  })

  it('WOMEN: an age-band variant resolves to the pooled variant sku', () => {
    const c = detectCollectionFromStock(STOCK, '133T')!
    expect(c.collectionType).toBe('WOMEN')
    expect(matchCollectionStock(STOCK, c, { variant: 'TWO PIECE (10Y-14Y)' })?.sku).toBe('133T-TWO-PIECE')
    expect(matchCollectionStock(STOCK, c, { variant: 'ORNA' })?.sku).toBe('133T-ORNA')
  })

  it('SINGLE: resolves to its one stock row by code alone, with no variant selected', () => {
    const c = detectCollectionFromStock(STOCK, '501')!
    expect(c.collectionType).toBe('SINGLE')
    expect(matchCollectionStock(STOCK, c, {})?.sku).toBe('501')
    expect(matchCollectionStock(STOCK, c, { variant: '' })?.sku).toBe('501')
  })
})
