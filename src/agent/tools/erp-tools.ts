import { roundMoney } from '@/lib/money'
import {
  listAgentOrders,
  getAgentOrdersSummary,
  buildOrdersSummary,
  crossCheckPendingCounts,
} from '@/lib/agent-api/orders.service'
import { listInventory } from '@/lib/agent-api/services/inventory.service'
import { listLowStock, listProducts } from '@/lib/agent-api/services/products.service'
import { getPrimaryImageUrl, listProductImages, listCatalogForImages } from '@/agent/lib/catalog/product-images'
import { listCustomers } from '@/lib/agent-api/services/customers.service'
import { listEmployees } from '@/lib/agent-api/services/employees.service'
import { getAttendanceHistory } from '@/lib/agent-api/services/attendance.service'
import { listFines } from '@/lib/agent-api/services/fines.service'
import { buildAdminAttendanceDashboard } from '@/lib/attendance-admin-dashboard'
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka, dhakaMidnightUtc, daysAgoYmd, addDaysYmd } from '@/lib/agent-api/dhaka-date'
import { DEFAULT_AGENT_BUSINESS_ID } from '@/lib/agent-api/constants'
import type { BusinessId } from '@/lib/businesses'
import type { AgentTool } from './registry'
import { buildOwnerBriefingData } from '@/agent/lib/owner-briefing-data'
import { getInventoryWithSales } from '@/lib/inventory-with-sales'
import { buildReorderSuggestions } from '@/lib/inventory-forecast'
import { segmentCustomers, type CustomerSegmentResult } from '@/lib/customer-intelligence'
import { analyzeReturns } from '@/lib/return-analysis'
import { analyzePricing } from '@/lib/pricing-insight'
import { isPendingActionExpired } from '@/agent/lib/pending-action'

// ── helpers ────────────────────────────────────────────────────────────────

function ymdToIso(ymd: string): string {
  return dhakaMidnightUtc(ymd).toISOString()
}

function resolveBusinessId(slug?: string): BusinessId {
  const raw = String(slug ?? DEFAULT_AGENT_BUSINESS_ID).trim().toUpperCase()
  if (raw === 'CDIT' || raw === 'CREATIVE_DIGITAL_IT') return 'CREATIVE_DIGITAL_IT'
  if (raw === 'ALMA_TRADING') return 'ALMA_TRADING'
  return 'ALMA_LIFESTYLE'
}

type AttendancePeriod = 'today' | 'yesterday' | 'week' | 'month'

function resolveAttendanceRange(input: {
  date?: string
  period?: string
}): { mode: 'day' | 'range'; startYmd: string; endYmd: string; period: AttendancePeriod | 'date' } {
  const today = todayYmdDhaka()
  if (input.date) {
    const ymd = String(input.date).slice(0, 10)
    return { mode: 'day', startYmd: ymd, endYmd: ymd, period: 'date' }
  }
  const period = (input.period ?? 'today') as AttendancePeriod
  switch (period) {
    case 'yesterday':
      return { mode: 'day', startYmd: daysAgoYmd(1), endYmd: daysAgoYmd(1), period }
    case 'week':
      return { mode: 'range', startYmd: daysAgoYmd(6), endYmd: today, period }
    case 'month':
      return { mode: 'range', startYmd: `${today.slice(0, 8)}01`, endYmd: today, period }
    default:
      return { mode: 'day', startYmd: today, endYmd: today, period: 'today' }
  }
}

async function fetchDayAttendance(businessId: BusinessId, ymd: string) {
  const date = dhakaMidnightUtc(ymd)
  const dash = await buildAdminAttendanceDashboard({
    businessIds: [businessId],
    date,
    monthStart: dhakaMidnightUtc(`${ymd.slice(0, 8)}01`),
    monthEnd: dhakaMidnightUtc(daysAgoYmd(-32, date)),
    scopeAllBusinesses: false,
  })

  const ops = await prisma.telegramOpsSetting.findUnique({ where: { businessId } })
  const grace = ops?.gracePeriodMinutes ?? 15

  const employees = dash.records.map((r) => ({
    employeeId: r.employeeId,
    name: r.employeeName,
    checkIn: r.checkInAt,
    checkOut: r.checkOutAt ?? null,
    hoursWorked: r.totalWorkMinutes > 0
      ? Math.round((r.totalWorkMinutes / 60) * 10) / 10
      : null,
    lateMinutes: r.lateMinutes,
    penaltyAmount: roundMoney(r.penaltyAmount),
    status: r.lateMinutes > grace ? 'late' : 'present',
  }))

  const present = employees.filter((e) => e.status === 'present')
  const late = employees.filter((e) => e.status === 'late')
  const absent = dash.absentEmployees.map((e) => ({
    employeeId: e.employeeId,
    name: e.name,
  }))

  const { fines } = await listFines({ limit: 100 })
  const dayFines = fines.filter((f) => f.createdAt.slice(0, 10) === ymd)

  return {
    date: ymd,
    businessId,
    counts: {
      present: present.length,
      late: late.length,
      absent: absent.length,
      notYetCheckedIn: 0,
      totalEmployees: dash.kpis.employeeCount,
      penaltyTotal: roundMoney(dash.kpis.todayPenaltyTotal),
    },
    present,
    late,
    absent,
    penalties: dayFines.map((f) => ({
      employeeId: f.employeeId,
      name: f.employeeName,
      amount: roundMoney(f.amount),
      reason: f.reason,
      status: f.status,
    })),
    meta: {
      officeStartMinutes: ops?.officeStartMinutes ?? 540,
      gracePeriodMinutes: grace,
    },
  }
}

async function fetchRangeAttendance(
  businessId: BusinessId,
  startYmd: string,
  endYmd: string,
  period: AttendancePeriod,
) {
  const { employees } = await listEmployees({ active: true, limit: 100 })
  const start = dhakaMidnightUtc(startYmd)
  const end = dhakaMidnightUtc(endYmd)
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1)

  const histories = await Promise.all(
    employees.map(async (emp) => {
      const hist = await getAttendanceHistory(emp.id, days)
      const inRange = hist.days.filter((d) => d.date >= startYmd && d.date <= endYmd)
      const presentDays = inRange.filter((d) => d.status === 'present' || d.status === 'late').length
      const lateDays = inRange.filter((d) => d.status === 'late').length
      const workingDays = days
      const absentDays = Math.max(0, workingDays - presentDays)
      return {
        employeeId: emp.id,
        name: emp.name,
        presentDays,
        absentDays,
        lateDays,
        attendanceRatePct: workingDays > 0
          ? Math.round((presentDays / workingDays) * 1000) / 10
          : 0,
        days: inRange,
      }
    }),
  )

  const { fines } = await listFines({ limit: 200 })
  const rangeFines = fines.filter((f) => {
    const d = f.createdAt.slice(0, 10)
    return d >= startYmd && d <= endYmd
  })

  return {
    period,
    startDate: startYmd,
    endDate: endYmd,
    businessId,
    counts: {
      present: histories.reduce((sum, h) => sum + h.presentDays, 0),
      absent: histories.reduce((sum, h) => sum + h.absentDays, 0),
      late: histories.reduce((sum, h) => sum + h.lateDays, 0),
      employees: employees.length,
      penaltyTotal: roundMoney(rangeFines.reduce((sum, f) => sum + f.amount, 0)),
    },
    employees: histories,
    penalties: rangeFines.map((f) => ({
      employeeId: f.employeeId,
      name: f.employeeName,
      amount: roundMoney(f.amount),
      reason: f.reason,
      date: f.createdAt.slice(0, 10),
      status: f.status,
    })),
  }
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
    'status: "pending" | "confirmed" | "processing" | "shipped" | "delivered" | "cancelled" | "refunded" | "unknown". ' +
    'Counts use mapped status from the synced sheet (meta.sheetSyncedAt). If meta.pendingCrossCheck.mismatch is true, mention sync delay — do not assert pending count as ERP fact. ' +
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
  description:
    'Search products by name or SKU keyword — checks the ERP product sheet AND the owner\'s ' +
    'Product Images catalog (stock groups + uploads), so a photographed product is ALWAYS ' +
    'findable here. Returns matching products with price/stock where known, and each product\'s ' +
    'REAL catalog images with their `storagePath`. Family sets live under VARIANT SKUs ' +
    '(e.g. code 720 → 720-ADULT / 720T-ORNA): search the BASE code ("720"), never conclude ' +
    '"product missing" without trying it. To render a creative from the REAL product, pass an ' +
    'image\'s `storagePath` as generate_image `referenceImageId` — never invent the product\'s look.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Name or SKU search term (base code like "720" matches its variants)' },
    },
    required: ['query'],
  },
  handler: async (input) => {
    try {
      const { products, meta } = await listProducts({
        search: String(input.query),
        limit: 20,
      })
      // Attach primary image + count to each product (lightweight).
      const enriched = await Promise.all(
        products.map(async (p) => ({
          ...p,
          primaryImageUrl: await getPrimaryImageUrl(p.sku).catch(() => null),
        })),
      )
      // Small result set (a single product or a family's variants) → return every
      // catalog image WITH its storagePath, so the head can SEE the product and
      // feed the real photo to generate_image as referenceImageId (owner incident
      // 2026-07-13: the head invented a fake 720 because paths were unreachable).
      let images: Array<{ productCode: string; url: string | null; storagePath: string; isPrimary: boolean }> | undefined
      if (enriched.length >= 1 && enriched.length <= 8) {
        const sets = await Promise.all(
          enriched.map(async (p) => {
            const all = await listProductImages(p.sku).catch(() => [])
            return all.map((i) => ({
              productCode: p.sku,
              url: i.url,
              storagePath: i.storagePath,
              isPrimary: i.isPrimary,
            }))
          }),
        )
        images = sets.flat()
      }
      // IMAGE-CATALOG fallback (owner round 7, 2026-07-13): the ERP products
      // sheet does NOT carry every catalog code — the owner's "Product Images"
      // screen groups STOCK rows + uploaded images (720/133 live THERE). When the
      // sheet search misses, search that catalog so the agent sees exactly what
      // the owner sees, and never again claims a photographed product "নেই".
      if (enriched.length === 0) {
        const { groups } = await listCatalogForImages().catch(() => ({ groups: [] as Awaited<ReturnType<typeof listCatalogForImages>>['groups'] }))
        const ql = String(input.query).toLowerCase()
        const hits = groups
          .filter((g) => g.code.toLowerCase().includes(ql) || g.name.toLowerCase().includes(ql))
          .slice(0, 8)
        if (hits.length > 0) {
          const sets = await Promise.all(
            hits.flatMap((g) =>
              g.members.map(async (m) => {
                const all = await listProductImages(m).catch(() => [])
                return all.map((i) => ({
                  productCode: m,
                  url: i.url,
                  storagePath: i.storagePath,
                  isPrimary: i.isPrimary,
                }))
              }),
            ),
          )
          return {
            success: true,
            data: {
              products: hits.map((g) => ({
                sku: g.code,
                name: g.name,
                category: g.category,
                kind: g.kind,
                members: g.members,
                imageCount: g.imageCount,
                primaryImageUrl: g.primaryImageUrl,
                source: 'image-catalog',
              })),
              images: sets.flat(),
              meta: { count: hits.length, source: 'image-catalog' },
            },
          }
        }
      }
      return { success: true, data: { products: enriched, images, meta } }
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

// ── get_attendance ─────────────────────────────────────────────────────────

const get_attendance: AgentTool = {
  name: 'get_attendance',
  description:
    'Returns attendance data: present/absent/late counts, per-employee check-in/check-out times, and penalties. ' +
    'period: "today" (default) | "yesterday" | "week" | "month". ' +
    'date: optional YYYY-MM-DD override (Asia/Dhaka). ' +
    'businessSlug: "ALMA_LIFESTYLE" | "ALMA_TRADING" | "CDIT". ' +
    'Single-day queries return today\'s roster snapshot; week/month return per-employee day rows and aggregate counts.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'Specific date YYYY-MM-DD (overrides period)' },
      businessSlug: { type: 'string', description: 'Business slug (default: ALMA_LIFESTYLE)' },
      period: {
        type: 'string',
        enum: ['today', 'yesterday', 'week', 'month'],
        description: 'Relative period when date is omitted',
      },
    },
    required: [],
  },
  handler: async (input) => {
    try {
      const businessId = resolveBusinessId(
        input.businessSlug ? String(input.businessSlug) : undefined,
      )
      const range = resolveAttendanceRange({
        date: input.date ? String(input.date) : undefined,
        period: input.period ? String(input.period) : undefined,
      })

      const data = range.mode === 'day'
        ? await fetchDayAttendance(businessId, range.startYmd)
        : await fetchRangeAttendance(businessId, range.startYmd, range.endYmd, range.period as AttendancePeriod)

      return { success: true, data }
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

      const [pendingCheck, refundedOrders] = await Promise.all([
        crossCheckPendingCounts(),
        listAgentOrders({ status: 'refunded', limit: 50 }),
      ])

      // Active attendance today
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = prisma as any
      const todayYmd = todayYmdDhaka()
      const dayStart = dhakaMidnightUtc(todayYmd)
      const dayEnd = dhakaMidnightUtc(addDaysYmd(todayYmd, 1))

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
          pendingOrdersCount: pendingCheck.pendingCount,
          gasPendingCount: pendingCheck.gasPendingCount,
          pendingOrdersCountSource: 'gas_sheet_mapped',
          pendingOrdersFetchedAt: pendingCheck.fetchedAt,
          sheetSyncedAt: pendingCheck.sheetSyncedAt,
          pendingCountMismatch: pendingCheck.mismatch
            ? {
                note: pendingCheck.note,
                gasPendingCount: pendingCheck.gasPendingCount,
                mappedPendingCount: pendingCheck.pendingCount,
              }
            : null,
          unknownOrderCount: pendingCheck.unknownCount,
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

const analyze_returns: AgentTool = {
  name: 'analyze_returns',
  description:
    'Analyze returns over a period: which products are returned most, return reasons, return rate, ' +
    'and revenue impact (paid vs unpaid returns). Use when owner asks about returns, "keno return baড়che", ' +
    'refund patterns, or product quality concerns.',
  input_schema: {
    type: 'object' as const,
    properties: {
      days: { type: 'number', description: 'Lookback window in days (default 30)' },
    },
  },
  handler: async (input) => {
    try {
      const days = typeof input.days === 'number' ? input.days : 30
      const data = await analyzeReturns({ days })
      return { success: true, data }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const analyze_pricing: AgentTool = {
  name: 'analyze_pricing',
  description:
    'Find products with thin margins or high-volume-low-profit, with price-review suggestions. ' +
    'Use when owner asks about profit, margins, pricing, "kon product e labh kom", or pricing strategy.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const data = await analyzePricing()
      return { success: true, data }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const get_customer_segments: AgentTool = {
  name: 'get_customer_segments',
  description:
    'Segment customers into win-back (repeat buyers gone quiet 45+ days), loyal (top repeat buyers), ' +
    'at-risk (slowing down), and new. Use when owner asks about customer retention, win-back, loyal ' +
    'customers, "ke fire ashe ni", or marketing/offer planning. Note: win-back customers are outside ' +
    'the 24h window so they CANNOT be auto-messaged — surface them to the owner with a suggested offer.',
  input_schema: {
    type: 'object' as const,
    properties: {
      segment: {
        type: 'string',
        enum: ['winBack', 'loyal', 'atRisk', 'newRecent', 'all'],
        description: 'Which segment to return (default all summary)',
      },
    },
  },
  handler: async (input) => {
    try {
      const seg = await segmentCustomers()
      const segment = input.segment ? String(input.segment) : 'all'

      if (segment && segment !== 'all') {
        const key = segment as keyof CustomerSegmentResult
        if (!(key in seg)) {
          return { success: false, error: `Unknown segment: ${segment}` }
        }
        return {
          success: true,
          data: {
            segment,
            count: seg[key].length,
            customers: seg[key],
            note: 'Win-back customers are outside the 24h Meta window — do NOT auto-DM them.',
          },
        }
      }

      return {
        success: true,
        data: {
          winBackCount: seg.winBack.length,
          loyalCount: seg.loyal.length,
          atRiskCount: seg.atRisk.length,
          newRecentCount: seg.newRecent.length,
          winBack: seg.winBack.slice(0, 20),
          loyal: seg.loyal.slice(0, 10),
          atRisk: seg.atRisk.slice(0, 10),
          newRecent: seg.newRecent.slice(0, 10),
          note: 'Win-back customers are outside the 24h Meta window — surface to owner with offer draft only.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const get_reorder_suggestions: AgentTool = {
  name: 'get_reorder_suggestions',
  description:
    'Forecast which products need reordering based on sell-rate vs stock. Returns items running low soon, ' +
    'with daily sell rate, days of stock left, and suggested reorder quantity. Use when owner asks ' +
    '"ki reorder korbo", "kon product shesh hocche", stock planning, or restock questions.',
  input_schema: {
    type: 'object' as const,
    properties: {
      leadDays: { type: 'number', description: 'Supplier lead time in days (default 7)' },
    },
  },
  handler: async (input) => {
    try {
      const leadDays = typeof input.leadDays === 'number' ? input.leadDays : 7
      const products = await getInventoryWithSales()
      const suggestions = buildReorderSuggestions(products, { leadDays })
      return {
        success: true,
        data: {
          count: suggestions.length,
          leadDays,
          suggestions,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const check_order_issues: AgentTool = {
  name: 'check_order_issues',
  description:
    'Scan orders for problems: stuck pending (3+ days), pile-ups, high cancel/return rates, payment gaps. ' +
    'Use when the owner asks about order health, "order e kono somossa?", or proactively in briefings. ' +
    'Read-only — suggest actions; owner must approve any corrective step.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const { detectOrderIssues } = await import('@/lib/order-monitor')
      const issues = await detectOrderIssues()
      return {
        success: true,
        data: {
          count: issues.length,
          healthy: issues.length === 0,
          issues,
          summaryBangla: issues.length
            ? issues.map((i) => `${i.severity === 'high' ? '🔴' : '🟡'} ${i.detail}`).join('\n')
            : 'অর্ডার সেকশন স্বাভাবিক — কোনো সমস্যা পাওয়া যায়নি।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const generate_owner_briefing: AgentTool = {
  name: 'generate_owner_briefing',
  description:
    'Generate a decision-focused business briefing for the owner: money, customers, stock, ads, staff, ' +
    'and 1-3 recommended decisions for today. Use when the owner asks for an overview, briefing, ' +
    '"business er obostha", "aj ki korbo", or a morning/daily rundown.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const brief = await buildOwnerBriefingData()
      return { success: true, data: brief }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const recall_business_knowledge: AgentTool = {
  name: 'recall_business_knowledge',
  description:
    'Recall what the agent has learned about a product, customer segment, staff member, channel, season, or the business — ' +
    'sell patterns, seasonality, best content, strengths, margin bands, etc. Use BEFORE making recommendations ' +
    'to ground advice in accumulated ALMA-specific knowledge. Confidence-weighted facts only.',
  input_schema: {
    type: 'object' as const,
    properties: {
      entityType: {
        type: 'string',
        enum: ['product', 'customer_segment', 'staff', 'channel', 'season', 'business', 'competitor'],
        description: 'What kind of entity to recall knowledge about',
      },
      entityName: {
        type: 'string',
        description: 'Optional name filter (e.g. product name "পাঞ্জাবি", staff name)',
      },
    },
    required: ['entityType'],
  },
  handler: async (input) => {
    try {
      const entityType = String(input.entityType ?? '')
      const entityName = typeof input.entityName === 'string' ? input.entityName : undefined
      const { recallFacts, searchFactsByName } = await import('@/lib/knowledge-graph')
      const facts = entityName
        ? await searchFactsByName(entityType, entityName)
        : await recallFacts(entityType)
      return {
        success: true,
        data: {
          entityType,
          entityName: entityName ?? null,
          count: facts.length,
          facts: facts.map((f) => ({
            entityId: f.entityId,
            entityName: f.entityName,
            attribute: f.attribute,
            value: f.value,
            confidence: Math.round(f.confidence * 100) / 100,
            evidenceCount: f.evidenceCount,
            source: f.source,
          })),
          note: facts.length
            ? 'Confidence 0.75+ = reliable, 0.55–0.74 = moderate, below 0.55 = tentative.'
            : 'এখনো এই বিষয়ে structured knowledge নেই — ডেটা জমা হচ্ছে।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const get_pending_approvals: AgentTool = {
  name: 'get_pending_approvals',
  description:
    'List all approvals currently waiting on the owner (across staff, ads, finance, alerts, personal). ' +
    'Use after the owner approves some items to remind them what is still pending, or when the owner asks ' +
    '"ki ki baki", "kichu pending ache?", or at the end of a multi-approval interaction.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const allRows = await prisma.agentPendingAction.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, type: true, summary: true, createdAt: true },
      })
      // Don't remind the owner about transient cards that have already passed their
      // TTL (they 410 on approve anyway). Lifecycle cards (dispatch_staff_tasks)
      // never expire, so they always remain in the list until acted on.
      const rows = allRows.filter((r) => !isPendingActionExpired(r.createdAt, r.type))
      return {
        success: true,
        data: {
          count: rows.length,
          pending: rows.map((r) => ({
            id: r.id,
            type: r.type,
            summary: r.summary.replace(/\n/g, ' ').slice(0, 200),
            createdAt: r.createdAt.toISOString(),
            ageMinutes: Math.round((Date.now() - r.createdAt.getTime()) / 60000),
          })),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const dismiss_pending_approvals: AgentTool = {
  name: 'dismiss_pending_approvals',
  description:
    'Cancel/dismiss approvals waiting on the owner — use when the owner says "cancel koro", "dismiss koro", ' +
    '"বাদ দাও", "এগুলো সরাও", or "সব cancel করো" about pending approvals (the cards from get_pending_approvals). ' +
    'This is the SAFE direction — it just clears requests, nothing new is executed, so no extra confirm card is needed. ' +
    'Scope it: pass id for one, ids for several, type to clear one kind (e.g. "staff_morale"), or all=true to clear every pending approval. ' +
    'Call get_pending_approvals first if you do not already have the ids. Nothing is hard-deleted — rows are marked rejected.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Single pending-approval id to dismiss' },
      ids: { type: 'array', items: { type: 'string' }, description: 'Several pending-approval ids to dismiss' },
      type: { type: 'string', description: 'Dismiss all pending approvals of this type (e.g. staff_morale, dispatch_staff_tasks)' },
      all: { type: 'boolean', description: 'true = dismiss every currently-pending approval' },
    },
  },
  handler: async (input) => {
    try {
      const ids = [
        ...(input.id ? [String(input.id)] : []),
        ...(Array.isArray(input.ids) ? input.ids.map((x) => String(x)) : []),
      ].filter(Boolean)
      const type = input.type ? String(input.type) : null
      const all = input.all === true

      if (!ids.length && !type && !all) {
        return {
          success: false,
          error: 'কোনটা dismiss করব নির্দিষ্ট করুন — id/ids দিন, অথবা type, অথবা all=true (সব pending)।',
        }
      }

      const where: Record<string, unknown> = { status: 'pending' }
      if (ids.length) where.id = { in: ids }
      else if (type) where.type = type
      // all=true → only the status:'pending' filter applies

      const rows = await prisma.agentPendingAction.findMany({
        where,
        select: { id: true, type: true, summary: true, businessId: true },
      })

      if (!rows.length) {
        return { success: true, data: { dismissed: 0, message: 'এই মুহূর্তে dismiss করার মতো কোনো pending approval নেই।' } }
      }

      await prisma.agentPendingAction.updateMany({
        where: { id: { in: rows.map((r) => r.id) }, status: 'pending' },
        data: { status: 'rejected', resolvedAt: new Date() },
      })

      // Best-effort cleanup: trust signal + unblock any duty waiting on these.
      for (const r of rows) {
        const trustBiz = (r.businessId as string) ?? 'ALMA_LIFESTYLE'
        const trustDomain = String(r.type).startsWith('staff_') || r.type === 'dispatch_staff_tasks' ? 'staff' : 'general'
        void import('@/agent/lib/trust-engine')
          .then((m) => m.recordRejection(trustDomain, String(r.type), trustBiz))
          .catch(() => {})
        void import('@/agent/lib/duty-approval-block')
          .then((m) => m.resolveDutyBlocksForLinkedAction(r.id))
          .catch(() => {})
      }

      return {
        success: true,
        data: {
          dismissed: rows.length,
          items: rows.map((r) => ({ id: r.id, type: r.type, summary: r.summary.replace(/\n/g, ' ').slice(0, 120) })),
          message: `✅ ${rows.length}টি pending approval dismiss করা হয়েছে (rejected — কিছু execute হয়নি)।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const get_strategic_review: AgentTool = {
  name: 'get_strategic_review',
  description:
    'Weekly strategic business review: week-over-week sales, growing/stalling products, return trends, ' +
    'new vs repeat customers, ad spend vs results, plus the agent\'s honest self-review (acceptance rate, ' +
    'outcome results, misses, adjustments) and data-backed focus for next week. Use when the owner asks ' +
    '"ei soptaher strategy ki", "business kemon cholche", "weekly strategic review", or wants altitude thinking.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const { message, data } = await import('@/lib/weekly-strategic-data').then((m) => m.buildWeeklyStrategicReview())
      return {
        success: true,
        data: {
          message,
          period: data.period,
          highlights: {
            wowRevenuePct: data.business.wowRevenuePct,
            suggestionsMade: data.selfReview.suggestionsMade,
            acceptanceRatePct: data.selfReview.acceptanceRatePct,
            focusCount: data.focusCandidates.length,
          },
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const get_marketing_intel: AgentTool = {
  name: 'get_marketing_intel',
  description:
    'Marketing guidance: upcoming BD seasonal events to prepare for, which products/categories need content, ' +
    'and what content approach has worked best (learned). Use for content planning, campaign timing, ' +
    '"ki content banabo", "samne kon season".',
  input_schema: {
    type: 'object' as const,
    properties: {
      category: {
        type: 'string',
        description: 'Optional category filter (e.g. punjabi, saree, winter)',
      },
    },
  },
  handler: async (input) => {
    try {
      const category = typeof input.category === 'string' ? input.category : undefined
      const { buildMarketingIntel } = await import('@/lib/content-intelligence')
      const intel = await buildMarketingIntel(category)
      return {
        success: true,
        data: {
          upcomingSeasons: intel.upcomingSeasons.map((s) => ({
            name: s.name,
            weeksUntil: s.weeksUntil,
            leadWeeks: s.leadWeeks,
            categories: s.categories,
            note: s.note,
            dateSource: s.dateSource,
            exactDate: s.exactDate,
            approximate: s.dateSource !== 'owner',
          })),
          staleProducts: intel.staleProducts,
          bestApproaches: intel.bestApproaches,
          recommendations: intel.recommendations,
          notes: intel.notes,
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
  get_attendance,
  get_dashboard_snapshot,
  analyze_returns,
  analyze_pricing,
  get_customer_segments,
  get_reorder_suggestions,
  check_order_issues,
  generate_owner_briefing,
  recall_business_knowledge,
  get_strategic_review,
  get_marketing_intel,
  get_pending_approvals,
  dismiss_pending_approvals,
]
