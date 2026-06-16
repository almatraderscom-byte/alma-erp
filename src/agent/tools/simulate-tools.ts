/**
 * Outcome simulation tool — projects business outcomes for proposed actions.
 * Uses real historical data to compute ranges (low/base/high).
 * All money in whole taka (no floats).
 */
import type { AgentTool } from './registry'
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

// ── Simulation types ────────────────────────────────────────────────────────

interface PromoSimInput {
  type: 'promo'
  discount_pct: number
  duration_days: number
  product_ids?: string[]
}

interface RestockSimInput {
  type: 'restock'
  product_id: string
  quantity: number
  unit_cost_taka: number
}

interface AdBudgetSimInput {
  type: 'ad_budget'
  amount_taka: number
  duration_days: number
}

type SimInput = PromoSimInput | RestockSimInput | AdBudgetSimInput

interface SimRange {
  low: number
  base: number
  high: number
}

interface SimResult {
  type: string
  assumptions: string[]
  projected_units: SimRange
  projected_revenue_taka: SimRange
  projected_gross_profit_taka: SimRange
  stock_out_date?: string | null
  break_even_days?: number | null
  roas?: SimRange
  tradeoffs: string[]
}

// ── Data fetching helpers ───────────────────────────────────────────────────

async function getRecentSalesData(daysBack: number): Promise<{
  totalUnits: number
  totalRevenue: number
  avgDailyUnits: number
  avgDailyRevenue: number
  avgOrderValue: number
}> {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
  try {
    const orders = await db.order.findMany({
      where: { createdAt: { gte: since }, status: { not: 'cancelled' } },
      select: { grandTotal: true, createdAt: true },
    })
    const totalRevenue = orders.reduce((sum: number, o: { grandTotal: number }) => sum + Math.round(o.grandTotal), 0)
    const totalUnits = orders.length
    const days = Math.max(1, daysBack)
    return {
      totalUnits,
      totalRevenue,
      avgDailyUnits: Math.round(totalUnits / days),
      avgDailyRevenue: Math.round(totalRevenue / days),
      avgOrderValue: totalUnits > 0 ? Math.round(totalRevenue / totalUnits) : 0,
    }
  } catch {
    return { totalUnits: 0, totalRevenue: 0, avgDailyUnits: 0, avgDailyRevenue: 0, avgOrderValue: 0 }
  }
}

async function getProductStock(productId: string): Promise<{ currentStock: number; avgDailySold: number }> {
  try {
    const product = await db.product.findUnique({
      where: { id: productId },
      select: { currentStock: true },
    })
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const orderCount = await db.orderItem.count({
      where: { productId, order: { createdAt: { gte: since }, status: { not: 'cancelled' } } },
    })
    return {
      currentStock: product?.currentStock ?? 0,
      avgDailySold: Math.max(1, Math.round(orderCount / 30)),
    }
  } catch {
    return { currentStock: 0, avgDailySold: 1 }
  }
}

// ── Simulation logic ────────────────────────────────────────────────────────

function simulatePromo(input: PromoSimInput, sales: Awaited<ReturnType<typeof getRecentSalesData>>): SimResult {
  const discountFactor = input.discount_pct / 100
  const liftLow = 1.1
  const liftBase = 1.3
  const liftHigh = 1.6

  const dailyUnits = sales.avgDailyUnits || 1
  const dailyRev = sales.avgDailyRevenue || 1000
  const days = Math.max(1, input.duration_days)

  const projUnits: SimRange = {
    low: Math.round(dailyUnits * liftLow * days),
    base: Math.round(dailyUnits * liftBase * days),
    high: Math.round(dailyUnits * liftHigh * days),
  }

  const discountedRevPerUnit = Math.round(sales.avgOrderValue * (1 - discountFactor))
  const projRevenue: SimRange = {
    low: projUnits.low * discountedRevPerUnit,
    base: projUnits.base * discountedRevPerUnit,
    high: projUnits.high * discountedRevPerUnit,
  }

  const marginAfterDiscount = Math.max(0, 1 - discountFactor - 0.4)
  const projProfit: SimRange = {
    low: Math.round(projRevenue.low * marginAfterDiscount),
    base: Math.round(projRevenue.base * marginAfterDiscount),
    high: Math.round(projRevenue.high * marginAfterDiscount),
  }

  const normalRevenue = dailyRev * days
  const breakEvenDays = projProfit.base > 0
    ? Math.ceil(Math.round(normalRevenue * discountFactor) / Math.max(1, Math.round(projProfit.base / days)))
    : null

  return {
    type: 'promo',
    assumptions: [
      `Baseline: ${dailyUnits} orders/day, avg ${sales.avgOrderValue}৳/order (30d data)`,
      `Discount: ${input.discount_pct}% off for ${days} days`,
      `Estimated COGS margin: ~40% (industry average for fashion)`,
      `Sales lift range: ${Math.round((liftLow - 1) * 100)}%-${Math.round((liftHigh - 1) * 100)}%`,
    ],
    projected_units: projUnits,
    projected_revenue_taka: projRevenue,
    projected_gross_profit_taka: projProfit,
    break_even_days: breakEvenDays,
    tradeoffs: [
      `Revenue ${discountFactor > 0.2 ? 'may drop' : 'likely stays stable'} per unit due to discount`,
      projProfit.base < normalRevenue * 0.3 ? 'Margin tight — consider smaller discount' : 'Margin looks sustainable',
      `Break-even: ${breakEvenDays ?? 'N/A'} days after promo ends (via repeat customers)`,
    ],
  }
}

function simulateRestock(
  input: RestockSimInput,
  stock: Awaited<ReturnType<typeof getProductStock>>,
): SimResult {
  const daysOfStockNow = stock.avgDailySold > 0
    ? Math.floor(stock.currentStock / stock.avgDailySold)
    : 999

  const stockOutDate = daysOfStockNow < 365
    ? new Date(Date.now() + daysOfStockNow * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    : null

  const totalInvestment = Math.round(input.quantity * input.unit_cost_taka)
  const daysOfNewStock = stock.avgDailySold > 0
    ? Math.floor(input.quantity / stock.avgDailySold)
    : 999

  const avgSellingPrice = Math.round(input.unit_cost_taka * 2.2)
  const projUnits: SimRange = {
    low: Math.round(input.quantity * 0.6),
    base: Math.round(input.quantity * 0.8),
    high: input.quantity,
  }
  const projRevenue: SimRange = {
    low: projUnits.low * avgSellingPrice,
    base: projUnits.base * avgSellingPrice,
    high: projUnits.high * avgSellingPrice,
  }
  const projProfit: SimRange = {
    low: projRevenue.low - totalInvestment,
    base: projRevenue.base - totalInvestment,
    high: projRevenue.high - totalInvestment,
  }

  return {
    type: 'restock',
    assumptions: [
      `Current stock: ${stock.currentStock} units, avg ${stock.avgDailySold}/day sold`,
      `Stock-out in: ~${daysOfStockNow} days without restock`,
      `Unit cost: ${input.unit_cost_taka}৳, estimated selling price: ~${avgSellingPrice}৳ (2.2x markup)`,
      `Sell-through rates: 60% low / 80% base / 100% high`,
    ],
    projected_units: projUnits,
    projected_revenue_taka: projRevenue,
    projected_gross_profit_taka: projProfit,
    stock_out_date: stockOutDate,
    break_even_days: projProfit.base > 0
      ? Math.ceil(totalInvestment / Math.max(1, Math.round(projProfit.base / daysOfNewStock)))
      : null,
    tradeoffs: [
      `Investment: ${totalInvestment}৳ — ${daysOfNewStock} days of stock`,
      stock.currentStock < stock.avgDailySold * 7
        ? '⚠️ Stock critically low — restock urgently needed'
        : 'Stock adequate for now',
      projProfit.low < 0 ? '⚠️ Low scenario shows loss — consider smaller order' : 'All scenarios profitable',
    ],
  }
}

function simulateAdBudget(input: AdBudgetSimInput, sales: Awaited<ReturnType<typeof getRecentSalesData>>): SimResult {
  const days = Math.max(1, input.duration_days)
  const dailyBudget = Math.round(input.amount_taka / days)

  const roasLow = 2.0
  const roasBase = 3.5
  const roasHigh = 5.0

  const projRevenue: SimRange = {
    low: Math.round(input.amount_taka * roasLow),
    base: Math.round(input.amount_taka * roasBase),
    high: Math.round(input.amount_taka * roasHigh),
  }

  const avgOrderVal = sales.avgOrderValue || 1500
  const projUnits: SimRange = {
    low: Math.round(projRevenue.low / avgOrderVal),
    base: Math.round(projRevenue.base / avgOrderVal),
    high: Math.round(projRevenue.high / avgOrderVal),
  }

  const margin = 0.45
  const projProfit: SimRange = {
    low: Math.round(projRevenue.low * margin) - input.amount_taka,
    base: Math.round(projRevenue.base * margin) - input.amount_taka,
    high: Math.round(projRevenue.high * margin) - input.amount_taka,
  }

  const roas: SimRange = { low: roasLow, base: roasBase, high: roasHigh }

  return {
    type: 'ad_budget',
    assumptions: [
      `Budget: ${input.amount_taka}৳ over ${days} days (${dailyBudget}৳/day)`,
      `ROAS range: ${roasLow}x - ${roasHigh}x (based on fashion e-commerce benchmarks)`,
      `Average order value: ${avgOrderVal}৳`,
      `Gross margin: ~45%`,
    ],
    projected_units: projUnits,
    projected_revenue_taka: projRevenue,
    projected_gross_profit_taka: projProfit,
    roas,
    break_even_days: projProfit.base > 0
      ? Math.ceil(days * (input.amount_taka / Math.max(1, projProfit.base + input.amount_taka)))
      : null,
    tradeoffs: [
      `Daily spend: ${dailyBudget}৳/day — ${projProfit.base > 0 ? 'profitable at base ROAS' : '⚠️ may not break even'}`,
      `ROAS below ${Math.ceil(1 / margin)}x = loss`,
      days < 7 ? 'Short run — may not optimize fully (recommend ≥7 days)' : 'Duration sufficient for optimization',
    ],
  }
}

// ── Tool definition ─────────────────────────────────────────────────────────

const simulate_outcome: AgentTool = {
  name: 'simulate_outcome',
  description:
    'Project the business outcome of a proposed action BEFORE executing it. ' +
    'Supports: promo (discount), restock, ad_budget. Returns low/base/high ranges for revenue, ' +
    'profit (whole taka), units, stock-out date, break-even, and tradeoffs. ' +
    'Present projections to owner with assumptions — never state projections as facts.',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['promo', 'restock', 'ad_budget'],
        description: 'Type of action to simulate',
      },
      discount_pct: { type: 'number', description: 'For promo: discount percentage (e.g. 15 for 15% off)' },
      duration_days: { type: 'number', description: 'For promo/ad_budget: how many days' },
      product_id: { type: 'string', description: 'For restock: product ID' },
      product_ids: { type: 'array', items: { type: 'string' }, description: 'For promo: specific product IDs (optional)' },
      quantity: { type: 'number', description: 'For restock: units to order' },
      unit_cost_taka: { type: 'number', description: 'For restock: cost per unit in whole taka' },
      amount_taka: { type: 'number', description: 'For ad_budget: total budget in whole taka' },
    },
    required: ['type'],
  },
  handler: async (input) => {
    const simType = String(input.type ?? '')

    try {
      switch (simType) {
        case 'promo': {
          const discountPct = Number(input.discount_pct ?? 0)
          const durationDays = Number(input.duration_days ?? 7)
          if (discountPct <= 0 || discountPct > 80) {
            return { success: false, error: 'discount_pct must be 1-80' }
          }
          const sales = await getRecentSalesData(30)
          const result = simulatePromo(
            { type: 'promo', discount_pct: discountPct, duration_days: durationDays, product_ids: input.product_ids as string[] | undefined },
            sales,
          )
          return { success: true, data: result }
        }

        case 'restock': {
          const productId = String(input.product_id ?? '')
          const qty = Math.round(Number(input.quantity ?? 0))
          const unitCost = Math.round(Number(input.unit_cost_taka ?? 0))
          if (!productId) return { success: false, error: 'product_id is required for restock' }
          if (qty <= 0) return { success: false, error: 'quantity must be positive' }
          if (unitCost <= 0) return { success: false, error: 'unit_cost_taka must be positive' }
          const stock = await getProductStock(productId)
          const result = simulateRestock({ type: 'restock', product_id: productId, quantity: qty, unit_cost_taka: unitCost }, stock)
          return { success: true, data: result }
        }

        case 'ad_budget': {
          const amountTaka = Math.round(Number(input.amount_taka ?? 0))
          const durationDays = Number(input.duration_days ?? 7)
          if (amountTaka <= 0) return { success: false, error: 'amount_taka must be positive' }
          const sales = await getRecentSalesData(30)
          const result = simulateAdBudget({ type: 'ad_budget', amount_taka: amountTaka, duration_days: durationDays }, sales)
          return { success: true, data: result }
        }

        default:
          return { success: false, error: `Unknown simulation type: ${simType}. Use promo, restock, or ad_budget.` }
      }
    } catch (err) {
      return { success: false, error: `Simulation failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

export const SIMULATE_TOOLS: AgentTool[] = [simulate_outcome]

export const SIMULATE_ROLE_PROMPT = `
## OUTCOME SIMULATION (File 18)
Before proposing a promo, restock, or ad budget change — call simulate_outcome FIRST.
- type='promo': discount + duration → projected units/revenue/profit ranges
- type='restock': product + quantity + cost → investment ROI + stock-out date
- type='ad_budget': budget + duration → projected ROAS/revenue/profit

CRITICAL: Present ranges (low/base/high) with stated assumptions. NEVER state projections as facts.
Owner decides — you present data + tradeoffs.
`
