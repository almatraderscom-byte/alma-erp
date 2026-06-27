import { describe, it, expect, beforeEach, vi } from 'vitest'

const db = {
  stock: null as any,
  calls: { stockUpdate: [] as any[], adjustCreate: [] as any[] },
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    lifestyleStockItem: {
      findFirst: vi.fn(async () => db.stock),
      update: vi.fn(async (args: any) => { db.calls.stockUpdate.push(args); return {} }),
    },
    lifestyleStockAdjustment: {
      create: vi.fn(async (args: any) => { db.calls.adjustCreate.push(args); return {} }),
    },
  },
}))

import { inventoryActionInPostgres } from '../write'

beforeEach(() => {
  db.stock = { id: 's1', sku: '133-KIDS', size: 'KIDS', currentStock: 100, reserved: 0, reorderLevel: 5, buyingPrice: 300, sold: 0 }
  db.calls = { stockUpdate: [], adjustCreate: [] }
})

describe('inventory adjust records an audit trail with the reason', () => {
  it('writes a stock-adjustment row with reason, delta and actor', async () => {
    const res = await inventoryActionInPostgres({
      action: 'adjust', sku: '133-KIDS', new_stock: 80, reason: 'damaged', actor: 'Maruf', actor_user_id: 'u1', business_id: 'ALMA_LIFESTYLE',
    }) as any
    expect(res.ok).toBe(true)
    expect(db.calls.adjustCreate).toHaveLength(1)
    expect(db.calls.adjustCreate[0].data).toMatchObject({
      sku: '133-KIDS', size: 'KIDS', previousStock: 100, newStock: 80, delta: -20, reason: 'damaged', actor: 'Maruf', actorUserId: 'u1',
    })
  })

  it('does not log when the stock level is unchanged', async () => {
    await inventoryActionInPostgres({ action: 'adjust', sku: '133-KIDS', new_stock: 100, reason: 'no change' })
    expect(db.calls.adjustCreate).toHaveLength(0)
  })
})
