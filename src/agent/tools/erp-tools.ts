import { roundMoney } from '@/lib/money'
import {
  listAgentOrders,
  getAgentOrdersSummary,
  buildOrdersSummary,
} from '@/lib/agent-api/orders.service'
import { listInventory } from '@/lib/agent-api/services/inventory.service'
import { listLowStock, listProducts } from '@/lib/agent-api/services/products.service'
import { listCustomers } from '@/lib/agent-api/services/customers.service'
import { listEmployees } from '@/lib/agent-api/services/employees.service'
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka, dhakaMidnightUtc, daysAgoYmd } from '@/lib/agent-api/dhaka-date'
import { DEFAULT_AGENT_BUSINESS_ID } from '@/lib/agent-api/constants'
import type { AgentTool } from './registry'

// ── helpers ────────────────────────────────────────────────────────────────

function ymdToIso(ymd: string): string {
  return new Date(`${ymd}T00:00:00+06:00`).toISOString()
}

// ── get_sales_summary ──────────────────────────────────────────────────────

const get_sales_summary: AgentTool = {
  name: 'get_sales_summary',
  description:
    'Returns sales summary (order count, revenue, avg order value, breakdown by status) for a date range. ' +
    'business: "ALMA_LIFESTYLE" | "ALMA_TRADING" | "CDIT". from/to: YYYY-MM-DD. ' +
    'groupBy: "status" (default) | "product".',
  input_schema: {
    type: 'object' as const,
    properties: {
      business: { type: 'string', description: 'Business slug (default: ALMA_LIFESTYLE)' },
      from: { type: 'string', description: 'Start date YYYY-MM-DD' },
      to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive)' },
      groupBy: { type: 'string', description: '"status" or "product"' },
    },
    required: ['from', 'to'],
  },
  handler: async (input) => {
    try {
      const from = String(input.from)
      const to = String(input.to)
      const { orders } = await listAgentOrders({
        startDate: from,
        endDate: to,
        fromIso: ymdToIso(from),
        toIso: ymdToIso(to),
        limit: 500,
      })

      const summary = buildOrdersSummary(orders, 'month')
      summary.period = `${from} → ${to}` as never

      const byProduct: Record<string, { orders: number; revenue: number }> = {}
      if (input.groupBy === 'product') {
        for (const o of orders) {
          const key = o.orderNumber ?? o.id
          if (!byProduct[key]) byProduct[key] = { orders: 0, revenue: 0 }
          byProduct[key].orders += 1
          byProduct[key].revenue = roundMoney(byProduct[key].revenue + o.totalAmount)
        }
      }

      return {
        success: true,
        data: {
          ...summary,
          totalRevenue: roundMoney(summary.totalRevenue),
          ...(input.groupBy === 'product' ? { byProduct } : {}),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_orders ─────────────────────────────────────────────────────────────

const get_orders: AgentTool = {
  name: 'get_orders',
  description:
    'Lists individual orders with optional status and date filters. ' +
    'status: "pending" | "confirmed" | "processing" | "shipped" | "delivered" | "cancelled" | "refunded". ' +
    'from/to: YYYY-MM-DD. limit: max 100 (default 20).',
  input_schema: {
    type: 'object' as const,
    properties: {
      business: { type: 'string' },
      status: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      limit: { type: 'number' },
    },
    required: [],
  },
  handler: async (input) => {
    try {
      const limit = Math.min(Number(input.limit ?? 20), 100)
      const from = input.from ? String(input.from) : undefined
      const to = input.to ? String(input.to) : undefined
      const { orders, meta } = await listAgentOrders({
        status: input.status ? String(input.status) : undefined,
        startDate: from,
        endDate: to,
        fromIso: from ? ymdToIso(from) : undefined,
        toIso: to ? ymdToIso(to) : undefined,
        limit,
      })
      return {
        success: true,
        data: {
          orders: orders.map((o) => ({ ...o, totalAmount: roundMoney(o.totalAmount) })),
          meta,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_inventory_status ───────────────────────────────────────────────────

const get_inventory_status: AgentTool = {
  name: 'get_inventory_status',
  description:
    'Returns per-product stock levels. ' +
    'lowStockOnly: true → only items at or below reorder level. ' +
    'deadStockDays: number → flag items with currentStock > 0 but reorderLevel = 0 (proxy for dead stock).',
  input_schema: {
    type: 'object' as const,
    properties: {
      business: { type: 'string' },
      lowStockOnly: { type: 'boolean' },
      deadStockDays: { type: 'number', description: 'Minimum days with no reorder signal to flag' },
    },
    required: [],
  },
  handler: async (input) => {
    try {
      const inv = await listInventory()
      let items = inv.items

      if (input.lowStockOnly) {
        items = items.filter((i) => i.currentStock <= i.reorderLevel)
      }

      const result = items.map((i) => ({
        ...i,
        deadStock: input.deadStockDays ? i.reorderLevel === 0 && i.currentStock > 0 : undefined,
      }))

      return {
        success: true,
        data: {
          items: result,
          meta: { totalSkus: inv.meta.count, shown: result.length },
          summary: inv.summary,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_product ────────────────────────────────────────────────────────────

const get_product: AgentTool = {
  name: 'get_product',
  description: 'Search products by name or SKU keyword. Returns matching products with price and stock.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Name or SKU search term' },
    },
    required: ['query'],
  },
  handler: async (input) => {
    try {
      const { products, meta } = await listProducts({
        search: String(input.query),
        limit: 20,
      })
      return { success: true, data: { products, meta } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_customer_summary ───────────────────────────────────────────────────

const get_customer_summary: AgentTool = {
  name: 'get_customer_summary',
  description:
    'Returns customer list sorted by total spend. ' +
    'query: optional name/phone search. topN: return only top N customers by spend (default 20).',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string' },
      topN: { type: 'number', description: 'Top N customers by total spend (default 20)' },
    },
    required: [],
  },
  handler: async (input) => {
    try {
      const { customers } = await listCustomers({
        search: input.query ? String(input.query) : undefined,
        limit: 500,
      })
      const sorted = [...customers].sort((a, b) => b.totalSpent - a.totalSpent)
      const topN = Math.min(Number(input.topN ?? 20), 200)
      const top = sorted.slice(0, topN)
      return {
        success: true,
        data: {
          customers: top.map((c) => ({ ...c, totalSpent: roundMoney(c.totalSpent) })),
          meta: {
            total: customers.length,
            shown: top.length,
            newCustomers: customers.filter((c) => c.totalOrders <= 1).length,
            returningCustomers: customers.filter((c) => c.totalOrders > 1).length,
          },
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_employee_overview ──────────────────────────────────────────────────

const get_employee_overview: AgentTool = {
  name: 'get_employee_overview',
  description:
    'Returns active employee roster (name, role) with aggregate wallet/advance summary. ' +
    'Does NOT include individual salary figures unless the user explicitly asks for salary details.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const { employees, meta } = await listEmployees({ active: true, limit: 100 })

      // Count pending advance requests (aggregate only — no individual salary)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = prisma as any
      let pendingAdvances = 0
      try {
        pendingAdvances = await db.walletRequest.count({
          where: {
            businessId: DEFAULT_AGENT_BUSINESS_ID,
            status: 'PENDING',
            isArchived: false,
          },
        })
      } catch {
        // WalletRequest may not exist in all deployments; ignore
      }

      const todayYmd = todayYmdDhaka()
      const monthStart = dhakaMidnightUtc(`${todayYmd.slice(0, 8)}01`)

      const fineAgg = await db.employeeLedgerEntry.aggregate({
        where: {
          businessId: DEFAULT_AGENT_BUSINESS_ID,
          type: 'PENALTY',
          isArchived: false,
          createdAt: { gte: monthStart },
        },
        _sum: { amount: true },
        _count: { id: true },
      })

      return {
        success: true,
        data: {
          employees: employees.map((e) => ({
            id: e.id,
            name: e.name,
            role: e.role,
            active: e.active,
            joinedAt: e.joinedAt,
          })),
          meta: {
            totalActive: meta.count,
            pendingAdvanceRequests: pendingAdvances,
            finesThisMonth: {
              totalAmount: roundMoney(Number(fineAgg._sum?.amount ?? 0)),
              count: Number(fineAgg._count?.id ?? 0),
            },
          },
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_dashboard_snapshot ─────────────────────────────────────────────────

const get_dashboard_snapshot: AgentTool = {
  name: 'get_dashboard_snapshot',
  description:
    "Returns today's business snapshot: orders, revenue, pending orders, and pending returns for the given business.",
  input_schema: {
    type: 'object' as const,
    properties: {
      business: { type: 'string', description: 'Business slug (default: ALMA_LIFESTYLE)' },
    },
    required: [],
  },
  handler: async () => {
    try {
      const todaySummary = await getAgentOrdersSummary('today')

      const [pendingOrders, refundedOrders] = await Promise.all([
        listAgentOrders({ status: 'pending', limit: 100 }),
        listAgentOrders({ status: 'refunded', limit: 50 }),
      ])

      // Active attendance today
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = prisma as any
      const todayYmd = todayYmdDhaka()
      const dayStart = dhakaMidnightUtc(todayYmd)
      const dayEnd = dhakaMidnightUtc(
        daysAgoYmd(-1, new Date(`${todayYmd}T00:00:00+06:00`)),
      )

      let checkedInToday = 0
      try {
        checkedInToday = await db.attendanceRecord.count({
          where: {
            businessId: DEFAULT_AGENT_BUSINESS_ID,
            isArchived: false,
            checkInAt: { gte: dayStart, lt: dayEnd },
          },
        })
      } catch {
        // ignore
      }

      return {
        success: true,
        data: {
          date: todayYmd,
          todayOrders: todaySummary.totalOrders,
          todayRevenue: roundMoney(todaySummary.totalRevenue),
          pendingOrdersCount: pendingOrders.meta.count,
          pendingReturnsCount: refundedOrders.meta.count,
          checkedInEmployees: checkedInToday,
          currency: 'BDT',
          generatedAt: new Date().toISOString(),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const ERP_TOOLS: AgentTool[] = [
  get_sales_summary,
  get_orders,
  get_inventory_status,
  get_product,
  get_customer_summary,
  get_employee_overview,
  get_dashboard_snapshot,
]
