import { describe, it, expect, vi, beforeEach } from 'vitest'

// createOrderInPostgres got two integrity guards (audit #4):
//   1. Idempotency — an identical order for the same customer+phone with the
//      same qty/sell price created in the last 2 minutes is returned as-is
//      instead of creating a duplicate and double-deducting stock.
//   2. Atomic, race-safe stock decrement — a conditional updateMany
//      (currentStock >= qty) replaces the old read-modify-write, so concurrent
//      orders can never oversell.
// We mock @/lib/prisma so the test exercises that control flow directly.

const h = vi.hoisted(() => {
  const orderFindFirst = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null)
  const orderFindMany = vi.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => [])
  const orderCreate = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({}))
  const stockFindFirst = vi.fn<(...a: unknown[]) => Promise<unknown>>()
  const stockUpdateMany = vi.fn<(...a: unknown[]) => Promise<{ count: number }>>(async () => ({ count: 1 }))
  const stockFindUnique = vi.fn<(...a: unknown[]) => Promise<unknown>>()
  const stockUpdate = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({}))
  const db: Record<string, unknown> = {
    lifestyleOrder: {
      findFirst: (...a: unknown[]) => orderFindFirst(...a),
      findMany: (...a: unknown[]) => orderFindMany(...a),
      create: (...a: unknown[]) => orderCreate(...a),
    },
    lifestyleStockItem: {
      findFirst: (...a: unknown[]) => stockFindFirst(...a),
      updateMany: (...a: unknown[]) => stockUpdateMany(...a),
      findUnique: (...a: unknown[]) => stockFindUnique(...a),
      update: (...a: unknown[]) => stockUpdate(...a),
    },
    $transaction: (fn: (tx: unknown) => unknown) => fn(db),
  }
  return { orderFindFirst, orderFindMany, orderCreate, stockFindFirst, stockUpdateMany, stockFindUnique, stockUpdate, db }
})
const { orderFindFirst, orderFindMany, orderCreate, stockFindFirst, stockUpdateMany, stockFindUnique, stockUpdate } = h

vi.mock('@/lib/prisma', () => ({ prisma: h.db }))
vi.mock('@/lib/lifestyle/prisma-mappers', () => ({ prismaOrderToGas: (o: unknown) => o }))

import { createOrderInPostgres } from '@/lib/lifestyle/write'

const baseBody = {
  customer: 'Karim',
  phone: '01700000000',
  payment: 'COD',
  source: 'FB',
  items: [{ product: 'Shirt', stock_sku: 'SKU1', qty: 2, sell_price: 500, cogs: 100 }],
}

describe('createOrderInPostgres — idempotency + atomic stock (audit #4)', () => {
  beforeEach(() => {
    orderFindFirst.mockReset(); orderFindFirst.mockResolvedValue(null)
    orderFindMany.mockReset(); orderFindMany.mockResolvedValue([])
    orderCreate.mockReset(); orderCreate.mockResolvedValue({})
    stockFindFirst.mockReset()
    stockUpdateMany.mockReset(); stockUpdateMany.mockResolvedValue({ count: 1 })
    stockFindUnique.mockReset()
    stockUpdate.mockReset(); stockUpdate.mockResolvedValue({})
  })

  it('returns the existing order (no duplicate, no stock deduct) on a recent identical submit', async () => {
    orderFindFirst.mockResolvedValue({ id: 'AL-0042', profit: 800 })
    const res = await createOrderInPostgres({ ...baseBody }) as Record<string, unknown>
    expect(res.ok).toBe(true)
    expect(res.order_id).toBe('AL-0042')
    expect(res.idempotent).toBe(true)
    expect(orderCreate).not.toHaveBeenCalled()
    expect(stockUpdateMany).not.toHaveBeenCalled()
  })

  it('deducts stock with a conditional gte guard (atomic) on a fresh order', async () => {
    stockFindFirst.mockResolvedValue({ id: 'st1', currentStock: 10, reserved: 0, reorderLevel: 2, buyingPrice: 100, sold: 5 })
    stockFindUnique.mockResolvedValue({ id: 'st1', currentStock: 8, reserved: 0, reorderLevel: 2, buyingPrice: 100 })
    const res = await createOrderInPostgres({ ...baseBody }) as Record<string, unknown>
    expect(res.ok).toBe(true)
    expect(res.order_id).toBe('AL-0001')
    // The decrement is the guarded updateMany, not a raw write.
    const call = stockUpdateMany.mock.calls[0][0] as { where: { currentStock?: { gte?: number } }; data: { currentStock?: { decrement?: number } } }
    expect(call.where.currentStock?.gte).toBe(2)
    expect(call.data.currentStock?.decrement).toBe(2)
    expect(orderCreate).toHaveBeenCalledTimes(1)
  })

  it('rejects (throws) when the guarded decrement matches no row — would-be oversell', async () => {
    stockFindFirst.mockResolvedValue({ id: 'st1', currentStock: 1, reserved: 0, reorderLevel: 2, buyingPrice: 100, sold: 5 })
    stockUpdateMany.mockResolvedValue({ count: 0 }) // not enough stock at write time
    await expect(createOrderInPostgres({ ...baseBody })).rejects.toThrow(/Insufficient stock/)
    expect(orderCreate).not.toHaveBeenCalled()
  })
})
