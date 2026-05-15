/**
 * Date-range filtering & dashboard aggregation for orders.
 * Frontend-first: filter cached orders client-side for instant UX.
 */
import {
  endOfDay,
  endOfMonth,
  format,
  isValid,
  parseISO,
  startOfDay,
  startOfMonth,
  subDays,
  subMonths,
} from 'date-fns'
import type { Order, OrderStatus } from '@/types'

// ── Date presets ─────────────────────────────────────────────────────────────

export type DatePreset =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'this_month'
  | 'last_month'
  | 'custom'

export interface DateRange {
  start: string // yyyy-MM-dd
  end: string   // yyyy-MM-dd
}

export const DATE_PRESETS: { id: DatePreset; label: string }[] = [
  { id: 'today',       label: 'Today' },
  { id: 'yesterday',   label: 'Yesterday' },
  { id: 'last7',       label: 'Last 7 days' },
  { id: 'last30',      label: 'Last 30 days' },
  { id: 'this_month',  label: 'This month' },
  { id: 'last_month',  label: 'Last month' },
  { id: 'custom',      label: 'Custom' },
]

function toYmd(d: Date): string {
  return format(d, 'yyyy-MM-dd')
}

/** Resolve a preset (and optional custom bounds) to an inclusive date range. */
export function getDatePresetRange(
  preset: DatePreset,
  customStart?: string,
  customEnd?: string,
  now: Date = new Date(),
): DateRange {
  const today = startOfDay(now)

  switch (preset) {
    case 'today':
      return { start: toYmd(today), end: toYmd(endOfDay(today)) }
    case 'yesterday': {
      const y = subDays(today, 1)
      return { start: toYmd(y), end: toYmd(endOfDay(y)) }
    }
    case 'last7':
      return { start: toYmd(subDays(today, 6)), end: toYmd(endOfDay(today)) }
    case 'last30':
      return { start: toYmd(subDays(today, 29)), end: toYmd(endOfDay(today)) }
    case 'this_month':
      return { start: toYmd(startOfMonth(today)), end: toYmd(endOfDay(today)) }
    case 'last_month': {
      const prev = subMonths(today, 1)
      return {
        start: toYmd(startOfMonth(prev)),
        end: toYmd(endOfMonth(prev)),
      }
    }
    case 'custom': {
      const s = customStart && isValid(parseISO(customStart)) ? customStart : toYmd(subDays(today, 29))
      const e = customEnd && isValid(parseISO(customEnd)) ? customEnd : toYmd(today)
      return s <= e ? { start: s, end: e } : { start: e, end: s }
    }
    default:
      return { start: toYmd(subDays(today, 29)), end: toYmd(endOfDay(today)) }
  }
}

export function formatDateRangeLabel(range: DateRange, preset: DatePreset): string {
  if (preset !== 'custom') {
    return DATE_PRESETS.find(p => p.id === preset)?.label ?? 'Custom'
  }
  if (range.start === range.end) return range.start
  return `${range.start} – ${range.end}`
}

/** True if order.date (yyyy-MM-dd) falls within [start, end] inclusive. */
export function isOrderInDateRange(orderDate: string, range: DateRange): boolean {
  if (!orderDate) return false
  const d = orderDate.slice(0, 10)
  return d >= range.start && d <= range.end
}

export function filterOrdersByDateRange(orders: Order[], range: DateRange): Order[] {
  return orders.filter(o => isOrderInDateRange(o.date, range))
}

// ── Order list filters ───────────────────────────────────────────────────────

export interface OrderFilters {
  search?: string
  status?: string
  source?: string
  payment?: string
}

export function applyOrderFilters(orders: Order[], filters: OrderFilters): Order[] {
  const search = (filters.search ?? '').trim().toLowerCase()
  return orders.filter(o => {
    if (filters.status && o.status !== filters.status) return false
    if (filters.source && o.source !== filters.source) return false
    if (filters.payment && o.payment !== filters.payment) return false
    if (search) {
      const hay = [o.id, o.customer, o.phone, o.product, o.tracking_id]
        .map(v => String(v).toLowerCase())
      if (!hay.some(v => v.includes(search))) return false
    }
    return true
  })
}

export function sortOrders(orders: Order[], sort: string): Order[] {
  const o = [...orders]
  if (sort === 'profit') return o.sort((a, b) => b.profit - a.profit)
  if (sort === 'price')  return o.sort((a, b) => b.sell_price - a.sell_price)
  if (sort === 'oldest') return o.sort((a, b) => a.date.localeCompare(b.date))
  return o.sort((a, b) => b.date.localeCompare(a.date))
}

export interface OrdersSummary {
  total: number
  total_revenue: number
  total_profit: number
  by_status: Record<string, number>
}

export function summarizeOrders(orders: Order[]): OrdersSummary {
  const by_status: Record<string, number> = {}
  let total_revenue = 0
  let total_profit = 0
  for (const o of orders) {
    total_revenue += o.sell_price
    total_profit += o.profit
    by_status[o.status] = (by_status[o.status] ?? 0) + 1
  }
  return { total: orders.length, total_revenue, total_profit, by_status }
}

// ── Dashboard aggregation ────────────────────────────────────────────────────

export interface DashboardKpisExtended {
  total_orders: number
  total_revenue: number
  total_profit: number
  total_cogs: number
  gross_margin: number
  avg_order_value: number
  delivered_count: number
  pending_count: number
  returned_count: number
  delivery_rate: number
  return_rate: number
  sla_breaches: number
  pending_action: number
  cod_amount: number
}

export interface DashboardMetrics {
  kpis: DashboardKpisExtended
  by_status: Record<string, number>
  by_source: Record<string, { orders: number; revenue: number }>
  by_payment: Record<string, number>
  by_category: Record<string, { orders: number; revenue: number; profit: number }>
  top_products: Array<{ product: string; orders: number; revenue: number; profit: number }>
  daily_trend: Array<{ date: string; revenue: number; profit: number; orders: number }>
  monthly_trend: Array<{ month: string; revenue: number; profit: number; orders: number; cogs: number }>
  sla_breaches: Array<{
    id: string; customer: string; sla_status: string
    days_pending: number; days_in_transit: number
  }>
  recent_orders: Array<Partial<Order>>
}

const EMPTY_KPIS: DashboardKpisExtended = {
  total_orders: 0, total_revenue: 0, total_profit: 0, total_cogs: 0,
  gross_margin: 0, avg_order_value: 0, delivered_count: 0, pending_count: 0,
  returned_count: 0, delivery_rate: 0, return_rate: 0, sla_breaches: 0,
  pending_action: 0, cod_amount: 0,
}

/** Aggregate dashboard KPIs, breakdowns, and chart series from a filtered order set. */
export function aggregateDashboardMetrics(orders: Order[]): DashboardMetrics {
  if (!orders.length) {
    return {
      kpis: { ...EMPTY_KPIS },
      by_status: {}, by_source: {}, by_payment: {}, by_category: {},
      top_products: [], daily_trend: [], monthly_trend: [],
      sla_breaches: [], recent_orders: [],
    }
  }

  let totalRev = 0, totalPro = 0, totalCOGS = 0
  let delivered = 0, returned = 0, pending = 0, codAmount = 0
  const byStatus: Record<string, number> = {}
  const bySource: Record<string, { orders: number; revenue: number }> = {}
  const byPayment: Record<string, number> = {}
  const byCat: Record<string, { orders: number; revenue: number; profit: number }> = {}
  const byProduct: Record<string, { orders: number; revenue: number; profit: number }> = {}
  const daily: Record<string, { date: string; revenue: number; profit: number; orders: number }> = {}
  const monthly: Record<string, { month: string; revenue: number; profit: number; orders: number; cogs: number }> = {}
  const slaBreaches: DashboardMetrics['sla_breaches'] = []

  for (const o of orders) {
    totalRev += o.sell_price
    totalPro += o.profit
    totalCOGS += o.cogs

    if (o.status === 'Delivered') delivered++
    if (o.status === 'Returned') returned++
    if (o.status === 'Pending') pending++

    if (String(o.payment).toUpperCase() === 'COD') codAmount += o.sell_price

    byStatus[o.status] = (byStatus[o.status] ?? 0) + 1
    byPayment[o.payment] = (byPayment[o.payment] ?? 0) + 1

    if (!bySource[o.source]) bySource[o.source] = { orders: 0, revenue: 0 }
    bySource[o.source].orders++
    bySource[o.source].revenue += o.sell_price

    if (!byCat[o.category]) byCat[o.category] = { orders: 0, revenue: 0, profit: 0 }
    byCat[o.category].orders++
    byCat[o.category].revenue += o.sell_price
    byCat[o.category].profit += o.profit

    const prodKey = o.product || 'Unknown'
    if (!byProduct[prodKey]) byProduct[prodKey] = { orders: 0, revenue: 0, profit: 0 }
    byProduct[prodKey].orders++
    byProduct[prodKey].revenue += o.sell_price
    byProduct[prodKey].profit += o.profit

    if (o.sla_status?.includes('BREACH')) {
      slaBreaches.push({
        id: o.id, customer: o.customer, sla_status: o.sla_status,
        days_pending: o.days_pending, days_in_transit: o.days_in_transit,
      })
    }

    const d = o.date?.slice(0, 10)
    if (d) {
      if (!daily[d]) daily[d] = { date: d, revenue: 0, profit: 0, orders: 0 }
      daily[d].revenue += o.sell_price
      daily[d].profit += o.profit
      daily[d].orders++

      const parsed = parseISO(d)
      if (isValid(parsed)) {
        const key = format(parsed, 'yyyy-MM')
        const mon = format(parsed, 'MMM yyyy')
        if (!monthly[key]) monthly[key] = { month: mon, revenue: 0, profit: 0, orders: 0, cogs: 0 }
        monthly[key].revenue += o.sell_price
        monthly[key].profit += o.profit
        monthly[key].cogs += o.cogs
        monthly[key].orders++
      }
    }
  }

  const n = orders.length
  const top_products = Object.entries(byProduct)
    .map(([product, v]) => ({ product, ...v }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 8)

  const recent_orders = [...orders]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 10)
    .map(o => ({
      id: o.id, date: o.date, customer: o.customer, product: o.product,
      status: o.status, sell_price: o.sell_price, profit: o.profit,
    }))

  return {
    kpis: {
      total_orders: n,
      total_revenue: totalRev,
      total_profit: totalPro,
      total_cogs: totalCOGS,
      gross_margin: totalRev > 0 ? Math.round(totalPro / totalRev * 100) : 0,
      avg_order_value: n > 0 ? Math.round(totalRev / n) : 0,
      delivered_count: delivered,
      pending_count: pending,
      returned_count: returned,
      delivery_rate: n > 0 ? Math.round(delivered / n * 100) : 0,
      return_rate: n > 0 ? Math.round(returned / n * 100) : 0,
      sla_breaches: slaBreaches.length,
      pending_action: (byStatus['Pending'] ?? 0) + (byStatus['Confirmed'] ?? 0),
      cod_amount: codAmount,
    },
    by_status: byStatus,
    by_source: bySource,
    by_payment: byPayment,
    by_category: byCat,
    top_products,
    daily_trend: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date)),
    monthly_trend: Object.keys(monthly).sort().map(k => monthly[k]),
    sla_breaches: slaBreaches,
    recent_orders,
  }
}

export function statusCountsForPills(
  orders: Order[],
  statuses: OrderStatus[],
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const s of statuses) counts[s] = 0
  for (const o of orders) counts[o.status] = (counts[o.status] ?? 0) + 1
  return counts
}
