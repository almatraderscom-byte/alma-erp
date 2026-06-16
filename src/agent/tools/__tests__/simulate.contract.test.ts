import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = {
  order: { findMany: vi.fn() },
  orderItem: { count: vi.fn() },
  product: { findUnique: vi.fn() },
  agentToolEvent: { create: vi.fn() },
  agentCostEvent: { findUnique: vi.fn(), create: vi.fn().mockResolvedValue({ id: 'c1' }) },
}
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

beforeEach(() => vi.clearAllMocks())

describe('simulate_outcome — promo', () => {
  it('returns whole-taka projections with low/base/high ranges', async () => {
    const { SIMULATE_TOOLS } = await import('@/agent/tools/simulate-tools')
    const tool = SIMULATE_TOOLS.find(t => t.name === 'simulate_outcome')!

    mockPrisma.order.findMany.mockResolvedValue([
      { grandTotal: 1500, createdAt: new Date() },
      { grandTotal: 2000, createdAt: new Date() },
      { grandTotal: 1800, createdAt: new Date() },
    ])

    const result = await tool.handler({ type: 'promo', discount_pct: 15, duration_days: 7 })
    expect(result.success).toBe(true)

    const data = result.data as Record<string, unknown>
    expect(data.type).toBe('promo')
    expect(data.assumptions).toBeDefined()
    expect(data.tradeoffs).toBeDefined()

    const revenue = data.projected_revenue_taka as { low: number; base: number; high: number }
    expect(revenue.low).toBeLessThanOrEqual(revenue.base)
    expect(revenue.base).toBeLessThanOrEqual(revenue.high)
    expect(Number.isInteger(revenue.low)).toBe(true)
    expect(Number.isInteger(revenue.base)).toBe(true)

    const profit = data.projected_gross_profit_taka as { low: number; base: number; high: number }
    expect(Number.isInteger(profit.low)).toBe(true)
  })

  it('rejects invalid discount_pct', async () => {
    const { SIMULATE_TOOLS } = await import('@/agent/tools/simulate-tools')
    const tool = SIMULATE_TOOLS.find(t => t.name === 'simulate_outcome')!

    const result = await tool.handler({ type: 'promo', discount_pct: 0 })
    expect(result.success).toBe(false)
    expect(result.error).toContain('discount_pct')
  })
})

describe('simulate_outcome — restock', () => {
  it('computes stock-out date as UTC midnight YYYY-MM-DD', async () => {
    const { SIMULATE_TOOLS } = await import('@/agent/tools/simulate-tools')
    const tool = SIMULATE_TOOLS.find(t => t.name === 'simulate_outcome')!

    mockPrisma.product.findUnique.mockResolvedValue({ currentStock: 10 })
    mockPrisma.orderItem.count.mockResolvedValue(30)

    const result = await tool.handler({
      type: 'restock',
      product_id: 'prod-1',
      quantity: 100,
      unit_cost_taka: 500,
    })
    expect(result.success).toBe(true)

    const data = result.data as Record<string, unknown>
    expect(data.type).toBe('restock')

    const stockOutDate = data.stock_out_date as string | null
    if (stockOutDate) {
      expect(stockOutDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }

    const profit = data.projected_gross_profit_taka as { low: number; base: number; high: number }
    expect(Number.isInteger(profit.low)).toBe(true)
    expect(Number.isInteger(profit.base)).toBe(true)
  })

  it('rejects missing product_id', async () => {
    const { SIMULATE_TOOLS } = await import('@/agent/tools/simulate-tools')
    const tool = SIMULATE_TOOLS.find(t => t.name === 'simulate_outcome')!

    const result = await tool.handler({ type: 'restock', quantity: 50, unit_cost_taka: 200 })
    expect(result.success).toBe(false)
    expect(result.error).toContain('product_id')
  })
})

describe('simulate_outcome — ad_budget', () => {
  it('returns ROAS ranges and whole-taka profit', async () => {
    const { SIMULATE_TOOLS } = await import('@/agent/tools/simulate-tools')
    const tool = SIMULATE_TOOLS.find(t => t.name === 'simulate_outcome')!

    mockPrisma.order.findMany.mockResolvedValue([
      { grandTotal: 1500, createdAt: new Date() },
      { grandTotal: 2000, createdAt: new Date() },
    ])

    const result = await tool.handler({ type: 'ad_budget', amount_taka: 10000, duration_days: 14 })
    expect(result.success).toBe(true)

    const data = result.data as Record<string, unknown>
    expect(data.type).toBe('ad_budget')

    const roas = data.roas as { low: number; base: number; high: number }
    expect(roas.low).toBeLessThan(roas.high)

    const profit = data.projected_gross_profit_taka as { low: number; base: number; high: number }
    expect(Number.isInteger(profit.low)).toBe(true)
  })

  it('rejects zero budget', async () => {
    const { SIMULATE_TOOLS } = await import('@/agent/tools/simulate-tools')
    const tool = SIMULATE_TOOLS.find(t => t.name === 'simulate_outcome')!

    const result = await tool.handler({ type: 'ad_budget', amount_taka: 0 })
    expect(result.success).toBe(false)
  })
})

describe('simulate_outcome — errors', () => {
  it('returns error for unknown type', async () => {
    const { SIMULATE_TOOLS } = await import('@/agent/tools/simulate-tools')
    const tool = SIMULATE_TOOLS.find(t => t.name === 'simulate_outcome')!

    const result = await tool.handler({ type: 'unknown' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown simulation type')
  })
})

describe('simulate routing', () => {
  it('"restock simulate koro" routes to finance group', async () => {
    const { selectToolGroupsSync } = await import('@/agent/tools/select-tools')
    const result = selectToolGroupsSync('restock simulate koro ei product er', { personalMode: false, businessId: 'ALMA_LIFESTYLE' })
    expect(result.groups).toContain('finance')
  })

  it('"what if 15% discount dei" routes to finance', async () => {
    const { selectToolGroupsSync } = await import('@/agent/tools/select-tools')
    const result = selectToolGroupsSync('what if 15% discount dei ei product e', { personalMode: false, businessId: 'ALMA_LIFESTYLE' })
    expect(result.groups).toContain('finance')
  })
})
