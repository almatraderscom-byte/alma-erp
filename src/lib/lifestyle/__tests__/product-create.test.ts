import { describe, it, expect, beforeEach, vi } from 'vitest'

const db = {
  stockBySku: {} as Record<string, unknown>,
  calls: { stockUpsert: [] as any[], stockCreate: [] as any[], productUpsert: [] as any[] },
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    lifestyleProduct: {
      upsert: vi.fn(async (args: any) => { db.calls.productUpsert.push(args); return {} }),
    },
    lifestyleStockItem: {
      findFirst: vi.fn(async ({ where }: any) => db.stockBySku[where.sku] ?? null),
      upsert: vi.fn(async (args: any) => { db.calls.stockUpsert.push(args); return {} }),
      create: vi.fn(async (args: any) => { db.calls.stockCreate.push(args); return {} }),
    },
  },
}))

import { createProductInPostgres } from '../write'

beforeEach(() => {
  db.stockBySku = {}
  db.calls = { stockUpsert: [], stockCreate: [], productUpsert: [] }
})

describe('createProductInPostgres', () => {
  it('collection mode creates a stock row per pool with code + quantity', async () => {
    const res = await createProductInPostgres({
      name: '475 Collection',
      inventory_mode: 'collection',
      collection_code: '475',
      collection_type: 'MEN',
      reorder_level: 5,
      bulk_rows: [
        { sku: '475-KIDS', sizeValue: 'KIDS', sizeCategory: 'KIDS', collectionCode: '475', collectionType: 'MEN', stockQty: 100, buyingPrice: 585, product: '475 KIDS', category: 'Panjabi' },
        { sku: '475-ADULT', sizeValue: 'ADULT', sizeCategory: 'ADULT', collectionCode: '475', collectionType: 'MEN', stockQty: 50, buyingPrice: 885, product: '475 ADULT', category: 'Panjabi' },
      ],
    }) as any
    expect(res).toMatchObject({ ok: true, product_id: '475', rows: 2 })
    expect(db.calls.stockUpsert).toHaveLength(2)
    const kids = db.calls.stockUpsert[0]
    expect(kids.where).toEqual({ sku_size: { sku: '475-KIDS', size: 'KIDS' } })
    expect(kids.create).toMatchObject({ sku: '475-KIDS', size: 'KIDS', currentStock: 100, available: 100, collectionCode: '475', status: 'IN STOCK', buyingPrice: 585 })
    expect(db.calls.stockUpsert[1].create).toMatchObject({ sku: '475-ADULT', currentStock: 50, available: 50 })
  })

  it('single product honours the opening stock instead of forcing 0', async () => {
    const res = await createProductInPostgres({
      name: 'Test Panjabi', sku: 'TP-1', initial_stock: 30, reorder_level: 5, default_cogs: 200, sync_to_stock: true,
    }) as any
    expect(res).toMatchObject({ ok: true, product_id: 'TP-1' })
    expect(db.calls.stockCreate).toHaveLength(1)
    expect(db.calls.stockCreate[0].data).toMatchObject({ sku: 'TP-1', currentStock: 30, available: 30, status: 'IN STOCK', buyingPrice: 200 })
  })

  it('does not duplicate the stock row when the sku already exists', async () => {
    db.stockBySku['TP-1'] = { id: 'x', sku: 'TP-1' }
    await createProductInPostgres({ name: 'Test', sku: 'TP-1', initial_stock: 10, sync_to_stock: true })
    expect(db.calls.stockCreate).toHaveLength(0)
  })
})
