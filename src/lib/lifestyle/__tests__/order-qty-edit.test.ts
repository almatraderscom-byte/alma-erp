import { describe, it, expect, beforeEach, vi } from 'vitest'

// In-memory prisma double. Records writes so we can assert stock/item/order moves.
const db = {
  order: null as any,
  items: [] as any[],
  stock: null as any,
  writes: { stock: [] as any[], item: [] as any[], order: [] as any[] },
}

function txClient() {
  return {
    lifestyleStockItem: {
      findFirst: vi.fn(async ({ where }: any) => (where.sku === db.stock?.sku ? db.stock : null)),
      update: vi.fn(async ({ data }: any) => { db.writes.stock.push(data); return data }),
    },
    lifestyleOrderItem: {
      update: vi.fn(async ({ data }: any) => { db.writes.item.push(data); return data }),
    },
    lifestyleOrder: {
      update: vi.fn(async ({ data }: any) => { db.writes.order.push(data); return data }),
    },
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    lifestyleOrder: {
      findUnique: vi.fn(async () => db.order),
      update: vi.fn(async ({ data }: any) => { db.writes.order.push(data); return data }),
    },
    lifestyleOrderItem: {
      findMany: vi.fn(async () => db.items),
    },
    $transaction: vi.fn(async (cb: any) => cb(txClient())),
  },
}))

import { updateOrderFieldInPostgres } from '../write'

function singleItemOrder() {
  db.order = {
    id: 'AL-0100', qty: 1, unitPrice: 930, discount: 0, addDiscount: 0, cogs: 300,
    courierCharge: 80, otherCosts: 0, advCost: 0, stockRestored: false,
  }
  db.items = [{ id: 'it1', sku: '133-KIDS', stockSku: '133-KIDS', size: '20', qty: 1, sellPrice: 930, cogs: 300 }]
  db.stock = { id: 's1', sku: '133-KIDS', size: 'KIDS', currentStock: 100, reserved: 0, sold: 5, buyingPrice: 300, reorderLevel: 5 }
}

beforeEach(() => {
  db.writes = { stock: [], item: [], order: [] }
})

describe('updateOrderFieldInPostgres — qty edits keep stock + items in sync', () => {
  it('single-item increase deducts the delta from stock and updates the line', async () => {
    singleItemOrder()
    const res = await updateOrderFieldInPostgres({ id: 'AL-0100', field: 'QTY', value: 3 })
    expect(res).toEqual({ ok: true })
    // delta = 3 - 1 = 2 deducted
    expect(db.writes.stock[0]).toMatchObject({ currentStock: 98, sold: 7, available: 98 })
    expect(db.writes.item[0]).toMatchObject({ qty: 3, subtotal: 2790 }) // 930 * 3
    expect(db.writes.order[0]).toMatchObject({ qty: 3, cogs: 900, inventoryCost: 900 }) // 300 * 3
  })

  it('single-item decrease returns stock and updates the line', async () => {
    singleItemOrder()
    db.order.qty = 3
    db.items[0].qty = 3
    const res = await updateOrderFieldInPostgres({ id: 'AL-0100', field: 'QTY', value: 1 })
    expect(res).toEqual({ ok: true })
    // delta = 1 - 3 = -2 → stock goes UP by 2
    expect(db.writes.stock[0]).toMatchObject({ currentStock: 102, sold: 3 })
    expect(db.writes.item[0]).toMatchObject({ qty: 1 })
  })

  it('refuses to change qty on a multi-item order (no stock writes)', async () => {
    singleItemOrder()
    db.items = [
      { id: 'it1', sku: '133-KIDS', stockSku: '133-KIDS', size: '20', qty: 1, sellPrice: 930, cogs: 300 },
      { id: 'it2', sku: '133-ADULT', stockSku: '133-ADULT', size: '42', qty: 1, sellPrice: 930, cogs: 300 },
    ]
    const res = await updateOrderFieldInPostgres({ id: 'AL-0100', field: 'QTY', value: 4 }) as any
    expect(res.error).toMatch(/multiple items/i)
    expect(db.writes.stock).toHaveLength(0)
  })

  it('no-op when qty is unchanged (multi-item edits of other fields stay safe)', async () => {
    singleItemOrder()
    const res = await updateOrderFieldInPostgres({ id: 'AL-0100', field: 'QTY', value: 1 })
    expect(res).toEqual({ ok: true })
    expect(db.writes.stock).toHaveLength(0)
    expect(db.writes.order).toHaveLength(0)
  })

  it('fails clearly when increasing beyond available stock', async () => {
    singleItemOrder()
    db.stock.currentStock = 1
    const res = await updateOrderFieldInPostgres({ id: 'AL-0100', field: 'QTY', value: 5 }) as any
    expect(res.error).toMatch(/insufficient stock/i)
  })
})

describe('updateOrderFieldInPostgres — unit price edits keep line items in sync', () => {
  it('single-item: updates the line item price/subtotal and header money (no stock move)', async () => {
    singleItemOrder()
    db.items[0].qty = 2
    db.order.qty = 2
    const res = await updateOrderFieldInPostgres({ id: 'AL-0100', field: 'UNIT_PRICE', value: 500 })
    expect(res).toEqual({ ok: true })
    expect(db.writes.stock).toHaveLength(0) // price change never moves stock
    expect(db.writes.item[0]).toMatchObject({ unitPrice: 500, sellPrice: 500, subtotal: 1000 }) // 500 * 2
    expect(db.writes.order[0]).toMatchObject({ unitPrice: 500 })
  })

  it('refuses to change unit price on a multi-item order', async () => {
    singleItemOrder()
    db.items = [
      { id: 'it1', sku: '133-KIDS', stockSku: '133-KIDS', size: '20', qty: 1, sellPrice: 930, cogs: 300 },
      { id: 'it2', sku: '133-ADULT', stockSku: '133-ADULT', size: '42', qty: 1, sellPrice: 930, cogs: 300 },
    ]
    const res = await updateOrderFieldInPostgres({ id: 'AL-0100', field: 'UNIT_PRICE', value: 500 }) as any
    expect(res.error).toMatch(/multiple items/i)
    expect(db.writes.item).toHaveLength(0)
  })

  it('no-op when unit price is unchanged (other-field edits stay safe)', async () => {
    singleItemOrder()
    const res = await updateOrderFieldInPostgres({ id: 'AL-0100', field: 'UNIT_PRICE', value: 930 })
    expect(res).toEqual({ ok: true })
    expect(db.writes.order).toHaveLength(0)
  })
})
