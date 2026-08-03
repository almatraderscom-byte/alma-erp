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
import {
  normalizeOrderStatus,
  isTerminalOrderStatus,
  VALID_ORDER_STATUSES,
} from '@/lib/lifestyle/order-status-workflow'
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
    'from/to: YYYY-MM-DD. limit: max 100 (default 20). ' +
    'orderNumber: exact single-order lookup by order/invoice number — searches the most recent 100 orders only; an empty result means "not among recent orders", NOT "does not exist".',
  input_schema: {
    type: 'object' as const,
    properties: {
      business: { type: 'string', enum: ['ALMA_LIFESTYLE', 'ALMA_TRADING', 'CDIT'], description: 'Business to query (default: current conversation business)' },
      status: { type: 'string', enum: ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded', 'unknown'], description: 'Filter by order status' },
      from: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive)' },
      to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive)' },
      limit: { type: 'number', description: 'Max orders to return (max 100, default 20)' },
      orderNumber: { type: 'string', description: 'Order/invoice number for a single-order status lookup (e.g. "1234", "#ALM-1234")' },
    },
    required: [],
  },
  handler: async (input) => {
    try {
      // orderNumber lookup scans the widest window the API allows (100) —
      // the number could be anywhere in the recent list.
      const limit = input.orderNumber ? 100 : Math.min(Number(input.limit ?? 20), 100)
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
      // LG-1 single-order lookup: filter AFTER fetch (the orders API has no
      // number filter). Digits-only equality absorbs "#", "ALM-" prefixes and
      // case on either side; falls back to case-insensitive exact match for
      // purely alphanumeric numbers.
      let matched = orders
      if (input.orderNumber) {
        const want = String(input.orderNumber).trim()
        const wantDigits = want.replace(/\D/g, '')
        matched = orders.filter((o) => {
          const have = (o.orderNumber ?? o.id ?? '').toString().trim()
          if (!have) return false
          if (have.toLowerCase() === want.toLowerCase()) return true
          const haveDigits = have.replace(/\D/g, '')
          return wantDigits.length >= 3 && haveDigits === wantDigits
        })
      }
      return {
        success: true,
        data: {
          orders: matched.map((o) => ({ ...o, totalAmount: roundMoney(o.totalAmount) })),
          meta: input.orderNumber
            ? { ...meta, orderNumberLookup: { query: String(input.orderNumber), searchedRecent: orders.length, found: matched.length } }
            : meta,
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
      business: { type: 'string', enum: ['ALMA_LIFESTYLE', 'ALMA_TRADING', 'CDIT'], description: 'Business to query (default: current conversation business)' },
      lowStockOnly: { type: 'boolean', description: 'true → only items at or below their reorder level' },
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
      query: { type: 'string', description: 'Optional customer name or phone search' },
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

// ── update_order (B1 — the first ERP write) ────────────────────────────────

/** Statuses the ERP itself accepts, in the words the owner uses for them. */
const ORDER_STATUSES = [
  'pending', 'confirmed', 'processing', 'shipped', 'delivered',
  'cancelled', 'returned', 'returned_paid', 'returned_unpaid',
] as const

/** What a status word means for stock — said on the card, because it is easy to miss. */
const STOCK_EFFECT: Record<string, string> = {
  cancelled: 'স্টক ফেরত যাবে',
  returned: 'স্টক ফেরত যাবে',
  returned_paid: 'স্টক ফেরত যাবে',
  returned_unpaid: 'স্টক ফেরত যাবে',
}

/**
 * A card is read by a person in a hurry. The first version of this printed an
 * order's whole `ORDER_ITEMS_JSON` blob as a before-value — screens of JSON
 * around the one line that mattered.
 */
function forOrderCard(value: unknown): string {
  if (value == null || value === '') return '(খালি)'
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text.length > 70 ? `${text.slice(0, 70)}…` : text
}

/**
 * The ERP's own courier spellings (`components/orders/new-order/constants.ts`).
 *
 * A model writes what Boss said — "steadfast" — and a lowercase value is a
 * different courier to every filter, report and dropdown that matches on the
 * name. Live on 2026-07-31: two orders ended up on `steadfast` while 313 sat on
 * `Pathao`.
 */
const CANONICAL_COURIERS = ['Pathao', 'Redx', 'Steadfast', 'Paperfly', 'E-courier', 'Sundarban', 'SA Paribahan']

function canonicalCourier(name: string): string {
  const key = name.trim().toLowerCase().replace(/[\s_-]+/g, '')
  const hit = CANONICAL_COURIERS.find((c) => c.toLowerCase().replace(/[\s_-]+/g, '') === key)
  return hit ?? name.trim()
}

async function findOrderByNumber(orderNumber: string) {
  const key = orderNumber.trim()
  if (!key) return null
  const digits = key.replace(/\D/g, '')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const exact = await db.lifestyleOrder.findFirst({
    where: { OR: [{ id: key }, { invoiceNum: key }] },
  })
  if (exact) return exact
  if (digits.length < 3) return null
  // Digit-normalised EQUALITY, never `contains`: "123" must not quietly select
  // ALM-1234 because it is newer. Two matches is a question for Boss, not a
  // guess — the wrong order is a wrong customer.
  const candidates = await db.lifestyleOrder.findMany({
    where: { OR: [{ id: { contains: digits } }, { invoiceNum: { contains: digits } }] },
    orderBy: { date: 'desc' },
    take: 25,
  })
  const exactByDigits = (candidates as Array<{ id: string; invoiceNum: string | null }>).filter((o) => {
    const idDigits = String(o.id ?? '').replace(/\D/g, '')
    const invDigits = String(o.invoiceNum ?? '').replace(/\D/g, '')
    return idDigits === digits || invDigits === digits
  })
  if (exactByDigits.length === 1) return exactByDigits[0]
  if (exactByDigits.length > 1) return { __ambiguous: exactByDigits.map((o) => o.invoiceNum || o.id) }
  return null
}

/**
 * One order's proposed change, validated — the unit BOTH the single card and the
 * batch card are built from (B5: one card per job, not per item).
 *
 * Returns an error string the head can act on, or the payload the approval
 * executor will apply plus what the card should say.
 */
interface OrderChangePlan {
  orderId: string
  label: string
  customer: string
  product: string
  payload: Record<string, unknown>
  changes: Record<string, { before: unknown; after: unknown }>
  unchanged: string[]
  stockWarning: string | null
}

async function planOrderChange(
  input: Record<string, unknown>,
): Promise<{ error: string } | { plan: OrderChangePlan }> {
  const orderNumber = String(input.orderNumber ?? '').trim()
  if (!orderNumber) return { error: 'কোন order, সেটা বলুন (order/invoice number)।' }

  const order = await findOrderByNumber(orderNumber)
  if (order && (order as { __ambiguous?: string[] }).__ambiguous) {
    const list = (order as { __ambiguous: string[] }).__ambiguous.join(', ')
    return { error: `"${orderNumber}"-এ একাধিক অর্ডার মিলছে (${list}) — কোনটা, সেটা বলুন।` }
  }
  if (!order) {
    return { error: `order পাওয়া যায়নি: ${orderNumber} — get_orders দিয়ে নম্বরটা মিলিয়ে নিন।` }
  }

    const changes: Record<string, { before: unknown; after: unknown }> = {}
    const fields: Record<string, string> = {}
    const unchanged: string[] = []

    if (input.status != null) {
      const raw = String(input.status).trim()
      // The ERP has ONE spelling per status. "processing" is the word the
      // agent's order adapter shows for `Packed`; writing it verbatim (as the
      // first version did) produces an order no pending predicate matches and
      // no UI transition can move.
      const want = normalizeOrderStatus(raw)
      if (!VALID_ORDER_STATUSES.has(want)) {
        return { error: `status "${raw}" চেনা গেল না — ${ORDER_STATUSES.join(', ')}-এর একটা দিন।` }
      }
      const current = String(order.status ?? '').trim()
      if (normalizeOrderStatus(current) === want) unchanged.push('status')
      else if (isTerminalOrderStatus(current)) {
        // Reopening a cancelled/returned order re-applies the stock deduction.
        // The ERP's own route refuses this; a chat message must not be a way
        // around it.
        return {
          error: `${order.invoiceNum || order.id} ইতিমধ্যে ${current} — শেষ হয়ে যাওয়া অর্ডার আবার খোলা যায় না (খুললে স্টকও নড়বে)। দরকার হলে নতুন অর্ডার করুন।`,
        }
      }
      else changes.status = { before: order.status, after: want }
    }

    for (const [key, current] of [
      ['courier', order.courier],
      ['trackingId', order.trackingId],
    ] as const) {
      const raw = input[key]
      if (raw == null) continue
      // A courier is a name the rest of the ERP matches on — spell it the ERP's way.
      const next = key === 'courier' ? canonicalCourier(String(raw)) : String(raw).trim()
      if (next === String(current ?? '').trim()) unchanged.push(key)
      else {
        changes[key] = { before: current, after: next }
        fields[key] = next
      }
    }

    // The note is APPENDED, never replaced.
    //
    // Caught on the card, one click before it landed (2026-07-31): this ERP
    // keeps a machine-readable `ORDER_ITEMS_JSON:{…}` payload — every line
    // item, size, price and COGS of the order — in the very same `notes`
    // column a human note goes in. Replacing the field would have deleted the
    // order's items to write one sentence. A note is worth adding; nothing a
    // note says is worth that.
    if (input.notes != null) {
      const note = String(input.notes).trim()
      const existing = String(order.notes ?? '')
      // Compare against the HUMAN part only. The machine payload is a long
      // JSON string, so a short note ("black", "111", "paid") matches inside
      // it and would be dropped as already-present though nobody ever wrote it.
      const humanPart = existing
        .split('\n')
        .filter((line) => !line.trim().startsWith('ORDER_ITEMS_JSON'))
        .join('\n')
      if (!note) unchanged.push('notes')
      else if (humanPart.split('\n').some((line) => line.trim() === note)) unchanged.push('notes')
      else {
        const merged = existing ? `${existing}\n${note}` : note
        changes.notes = { before: existing ? '(আগের নোট অপরিবর্তিত থাকবে)' : '(খালি)', after: note }
        fields.notes = merged
      }
    }

  if (!Object.keys(changes).length) {
    const already = unchanged.length ? ` (${unchanged.join(', ')} আগে থেকেই এমনই আছে)` : ''
    return { error: `${order.invoiceNum || order.id}: বদলানোর মতো কিছু নেই${already}।` }
  }

  const reason = input.reason ? String(input.reason).trim().slice(0, 200) : null
  const statusAfter = changes.status ? String(changes.status.after) : null

  return {
    plan: {
      orderId: order.id,
      label: String(order.invoiceNum || order.id),
      customer: String(order.customer ?? ''),
      product: String(order.product ?? ''),
      payload: {
        orderId: order.id,
        invoiceNum: order.invoiceNum,
        status: statusAfter,
        fields,
        changes,
        reason,
      },
      changes,
      unchanged,
      stockWarning: statusAfter && STOCK_EFFECT[normalizeOrderStatus(statusAfter).toLowerCase()]
        ? STOCK_EFFECT[normalizeOrderStatus(statusAfter).toLowerCase()]
        : (statusAfter && isTerminalOrderStatus(statusAfter) ? 'স্টক ফেরত যাবে' : null),
    },
  }
}

function planLines(plan: OrderChangePlan): string {
  return Object.entries(plan.changes)
    .map(([field, v]) => `• ${field}: ${forOrderCard(v.before)} → ${forOrderCard(v.after)}`)
    .join('\n')
}

const update_order: AgentTool = {
  name: 'update_order',
  description:
    'Change an existing ERP order — status, courier, tracking id, or the note on it — in ONE approval card '
    + 'with before → after per field. Use for "order ta shipped kore dao", "tracking boshiye dao", '
    + '"oi order ta cancel koro". Send only what changes. Cancel/return statuses restore stock, and the card says so. '
    + 'After approval the order is read back from the ERP and the live values are reported — never claim it landed on your own. '
    + 'Money fields (price, discount, COGS) are NOT editable here. For SEVERAL orders at once use update_orders — one card, not one per order.',
  input_schema: {
    type: 'object' as const,
    properties: {
      orderNumber: { type: 'string', description: 'Order/invoice number as Boss says it (e.g. "1234", "#ALM-1234"), or the order id.' },
      status: { type: 'string', enum: [...ORDER_STATUSES], description: 'New status.' },
      courier: {
        type: 'string',
        // NOT an enum: schema validation runs BEFORE the handler, so a lowercase
        // "steadfast" would be rejected as invalid_args and never reach the
        // normaliser that exists to repair exactly that. Accept what the model
        // says; canonicalCourier decides how it is spelled.
        description: `Courier name. Stored in the ERP's own spelling — one of: ${CANONICAL_COURIERS.join(', ')}.`,
      },
      trackingId: { type: 'string', description: 'Courier tracking id.' },
      notes: {
        type: 'string',
        description:
          'A note to ADD to the order (appended — the existing note is never replaced). '
          + 'Only send this when Boss asked for a note; do not narrate your own change here.',
      },
      reason: { type: 'string', description: 'Why, in one line — stored with cancel/return, and shown on the card.' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['orderNumber'],
  },
  handler: async (input) => {
    try {
      const planned = await planOrderChange(input)
      if ('error' in planned) return { success: false, error: planned.error }
      const { plan } = planned

      const summary =
        `📦 অর্ডার আপডেট — ${plan.label}\n`
        + `${plan.customer} · ${plan.product}\n`
        + planLines(plan) + '\n'
        + (plan.unchanged.length ? `(অপরিবর্তিত: ${plan.unchanged.join(', ')})\n` : '')
        + (plan.payload.reason ? `কারণ: ${plan.payload.reason}\n` : '')
        + (plan.stockWarning ? `⚠️ ${plan.stockWarning}।\n` : '')
        + `\n✅ approve করলে সব একসাথে বসবে, তারপর ERP থেকে পড়ে মিলিয়ে দেখানো হবে।`

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const action = await (prisma as any).agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          businessId: 'ALMA_LIFESTYLE',
          type: 'erp_order_update',
          payload: { ...plan.payload, conversationId: input.conversationId ?? null },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          orderId: plan.orderId,
          changedFields: Object.keys(plan.changes),
          unchangedFields: plan.unchanged,
          message: `${Object.keys(plan.changes).length}টি পরিবর্তনের একটাই approval card পাঠানো হয়েছে।`,
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

/** A batch stays a batch a person can read — ten orders, not a hundred. */
const MAX_ORDERS_PER_BATCH = 15

const update_orders: AgentTool = {
  name: 'update_orders',
  description:
    'Change SEVERAL ERP orders in ONE approval card — "ei tin ta order shipped kore dao", '
    + '"ajker sob order e courier boshiye dao". Each order carries its own fields (status, courier, '
    + 'trackingId, notes) and the card shows before → after per order. Boss approves once for the whole job. '
    + 'Every order runs the same checks as a single update — cancel/return restores stock, a finished order '
    + 'cannot be reopened, money is not editable — and after approval each order is read back from the ERP '
    + 'and reported separately, so a partly-failed batch names WHICH order still needs a hand. '
    + `Maximum ${MAX_ORDERS_PER_BATCH} orders per card.`,
  input_schema: {
    type: 'object' as const,
    properties: {
      orders: {
        type: 'array',
        description: 'The orders to change — one entry each. An entry with nothing to change is refused, not silently skipped.',
        items: {
          type: 'object',
          properties: {
            orderNumber: { type: 'string', description: 'Order/invoice number, or the order id.' },
            status: { type: 'string', enum: [...ORDER_STATUSES], description: 'New status for THIS order.' },
            courier: {
              type: 'string',
              description: `Courier name for THIS order — stored in the ERP's own spelling (${CANONICAL_COURIERS.join(', ')}).`,
            },
            trackingId: { type: 'string', description: 'Courier tracking id for THIS order.' },
            notes: { type: 'string', description: 'A note to ADD to this order (appended, never replaces).' },
          },
          required: ['orderNumber'],
        },
      },
      reason: { type: 'string', description: 'Why this batch, in one line — shown on the card.' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['orders'],
  },
  handler: async (input) => {
    try {
      const raw = Array.isArray(input.orders) ? (input.orders as Array<Record<string, unknown>>) : []
      if (!raw.length) return { success: false, error: 'কোন কোন অর্ডার, সেটা দিন (orders খালি)।' }
      if (raw.length > MAX_ORDERS_PER_BATCH) {
        return {
          success: false,
          error: `একবারে সর্বোচ্চ ${MAX_ORDERS_PER_BATCH}টি অর্ডার — ${raw.length}টি দেওয়া হয়েছে। ভাগ করে পাঠান।`,
        }
      }

      const reason = input.reason ? String(input.reason).trim().slice(0, 200) : null
      const plans: OrderChangePlan[] = []
      const rejected: string[] = []
      const seen = new Set<string>()

      for (const entry of raw) {
        const planned = await planOrderChange({ ...entry, reason: entry.reason ?? reason })
        if ('error' in planned) {
          rejected.push(planned.error)
          continue
        }
        // The same order twice in one card would apply twice and read back once.
        if (seen.has(planned.plan.orderId)) {
          rejected.push(`${planned.plan.label}: একই অর্ডার দুবার এসেছে।`)
          continue
        }
        seen.add(planned.plan.orderId)
        plans.push(planned.plan)
      }

      // Nothing staged means nothing to approve — say what went wrong instead of
      // showing Boss an empty card.
      if (!plans.length) {
        return { success: false, error: `একটাও অর্ডার নেওয়া গেল না:\n${rejected.join('\n')}` }
      }

      const stockWarned = plans.filter((p) => p.stockWarning)
      const summary =
        `📦 ${plans.length}টি অর্ডার আপডেট — একটাই approval\n`
        + plans
          .map((p) => `\n▪ ${p.label} · ${p.customer}\n${planLines(p)}`)
          .join('')
        + '\n'
        + (reason ? `\nকারণ: ${reason}\n` : '')
        + (stockWarned.length ? `⚠️ ${stockWarned.map((p) => p.label).join(', ')} — স্টক ফেরত যাবে।\n` : '')
        + (rejected.length ? `\nবাদ পড়েছে (${rejected.length}): ${rejected.join(' · ')}\n` : '')
        + `\n✅ approve করলে সবগুলো একসাথে চলবে, তারপর প্রতিটা অর্ডার ERP থেকে পড়ে আলাদা করে দেখানো হবে।`

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const action = await (prisma as any).agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          businessId: 'ALMA_LIFESTYLE',
          type: 'erp_order_batch',
          payload: {
            items: plans.map((p) => p.payload),
            reason,
            rejected,
            conversationId: input.conversationId ?? null,
          },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          staged: plans.map((p) => p.label),
          rejected,
          message: `${plans.length}টি অর্ডারের জন্য একটাই approval card পাঠানো হয়েছে।`,
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

export const ERP_TOOLS: AgentTool[] = [
  get_sales_summary,
  get_orders,
  update_order,
  update_orders,
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
