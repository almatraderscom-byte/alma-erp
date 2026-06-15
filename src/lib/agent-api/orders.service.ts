import { getLifestyleOrder, getLifestyleOrders } from '@/lib/lifestyle/read'
import { getPeriodRangeDhaka, isoToYmd } from '@/lib/agent-api/period'
import { dhakaMidnightUtc } from '@/lib/agent-api/dhaka-date'
import type {
  AgentOrder,
  AgentOrderDetail,
  AgentOrdersSummary,
  OrderStatusSchema,
  SummaryPeriod,
} from '@/lib/agent-api/orders.schema'
import type { Order, OrderItem } from '@/types'
import type { z } from 'zod'

const DEFAULT_BUSINESS_ID = 'ALMA_LIFESTYLE'

type AgentStatus = z.infer<typeof OrderStatusSchema>

const ALMA_TO_AGENT: Record<string, AgentStatus> = {
  pending: 'pending',
  confirmed: 'confirmed',
  packed: 'processing',
  processing: 'processing',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  returned: 'refunded',
  returned_paid: 'refunded',
  returned_unpaid: 'refunded',
  refunded: 'refunded',
}

const AGENT_TO_ALMA: Partial<Record<AgentStatus, string>> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  processing: 'Packed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'CANCELLED',
  refunded: 'RETURNED',
}

function normalizeStatus(s: string): string {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, '_')
}

function mapStatus(almaStatus: string): AgentStatus {
  const norm = normalizeStatus(almaStatus)
  if (!norm) return 'unknown'
  const mapped = ALMA_TO_AGENT[norm]
  if (!mapped) {
    console.warn(
      `[orders] unmapped status "${almaStatus}" (normalized "${norm}") — treating as 'unknown', NOT pending`,
    )
    return 'unknown'
  }
  return mapped
}

function orderDateToIso(dateStr: string): string {
  const ymd = dateStr.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return new Date().toISOString()
  return dhakaMidnightUtc(ymd).toISOString()
}

function extractCity(address: string): string | null {
  const trimmed = address.trim()
  if (!trimmed) return null
  const parts = trimmed.split(',').map(p => p.trim()).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : trimmed
}

function itemCount(order: Order): number {
  if (order.items?.length) {
    return order.items.reduce((sum, i) => sum + Number(i.qty || 0), 0)
  }
  return Number(order.qty || 0)
}

function mapLineItems(items: OrderItem[] | undefined) {
  if (!items?.length) return undefined
  return items.map(item => ({
    sku: item.sku || item.product_code || undefined,
    name: item.product || 'Item',
    quantity: Math.max(1, Number(item.qty || 1)),
    unitPrice: Number(item.unit_price || item.sell_price || 0),
    lineTotal: Number(item.subtotal || item.qty * (item.unit_price || 0)),
  }))
}

export function mapOrderToAgent(order: Order): AgentOrder {
  return {
    id: String(order.id),
    orderNumber: order.invoice_num ? String(order.invoice_num) : undefined,
    customerName: order.customer || null,
    customerPhone: order.phone || null,
    totalAmount: Number(order.sell_price || 0),
    currency: 'BDT',
    status: mapStatus(String(order.status ?? '')),
    placedAt: orderDateToIso(order.date),
    itemCount: itemCount(order),
    paymentMethod: order.payment || null,
    shippingCity: extractCity(order.address || ''),
  }
}

export function mapOrderDetail(order: Order): AgentOrderDetail {
  const base = mapOrderToAgent(order)
  const lineItems = mapLineItems(order.items)
  const notes = order.notes?.trim() || null
  return { ...base, lineItems, notes }
}

export interface ListAgentOrdersInput {
  status?: string
  limit?: number
  startDate?: string
  endDate?: string
  fromIso?: string | null
  toIso?: string | null
}

export interface ListAgentOrdersMeta {
  count: number
  limit: number
  from: string | null
  to: string | null
  dataSource: 'gas_sheet' | 'supabase'
  fetchedAt: string
  sheetSyncedAt: string | null
  unknownCount?: number
  pendingCrossCheck?: {
    gasFilteredCount: number
    mappedPendingCount: number
    mismatch: boolean
    note: string | null
  }
}

export async function crossCheckPendingCounts(): Promise<{
  pendingCount: number
  gasPendingCount: number
  unknownCount: number
  sheetSyncedAt: string | null
  fetchedAt: string
  mismatch: boolean
  note: string | null
}> {
  const [statusFiltered, allRecent] = await Promise.all([
    listAgentOrders({ status: 'pending', limit: 500 }),
    listAgentOrders({ limit: 500 }),
  ])

  const mappedPending = allRecent.orders.filter((o) => o.status === 'pending').length
  const unknownCount = allRecent.orders.filter((o) => o.status === 'unknown').length
  const dbPendingCount = statusFiltered.meta.count
  const mismatch = dbPendingCount !== mappedPending

  let note: string | null = null
  if (mismatch) {
    note =
      `DB pending count ${dbPendingCount}, mapped count ${mappedPending} — status mismatch হতে পারে; verify করুন।`
  }
  if (unknownCount > 0) {
    const unk =
      `${unknownCount}টি অর্ডার unmapped status (unknown) — worker log-এ "[orders] unmapped status" দেখুন।`
    note = note ? `${note} ${unk}` : unk
  }

  return {
    pendingCount: mappedPending,
    gasPendingCount: dbPendingCount,
    unknownCount,
    sheetSyncedAt: null,
    fetchedAt: new Date().toISOString(),
    mismatch,
    note,
  }
}

export async function listAgentOrders(input: ListAgentOrdersInput): Promise<{
  orders: AgentOrder[]
  meta: ListAgentOrdersMeta
}> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
  const params: Record<string, string> = {
    business_id: DEFAULT_BUSINESS_ID,
    limit: String(Math.min(limit + 200, 500)),
  }

  // Auto-scope to last 60 days when no explicit date range is given.
  // Matches ERP UI behavior and prevents old orphaned orders from appearing.
  if (!input.startDate && !input.endDate) {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 60)
    params.startDate = cutoff.toISOString().slice(0, 10)
  }

  if (input.startDate) params.startDate = input.startDate
  if (input.endDate) params.endDate = input.endDate

  const almaStatus =
    input.status && input.status !== 'all'
      ? AGENT_TO_ALMA[input.status.toLowerCase() as AgentStatus]
      : undefined
  if (almaStatus) params.status = almaStatus

  const data = await getLifestyleOrders(params)
  let orders = (data.orders ?? []).map(mapOrderToAgent)
  const fromSupabase = true

  if (input.fromIso || input.toIso) {
    const fromYmd = input.fromIso ? isoToYmd(input.fromIso) : null
    const toYmd = input.toIso ? isoToYmd(input.toIso) : null
    orders = orders.filter(o => {
      const ymd = isoToYmd(o.placedAt)
      if (fromYmd && ymd < fromYmd) return false
      if (toYmd && ymd > toYmd) return false
      return true
    })
  }

  if (input.status && input.status !== 'all') {
    const want = input.status.toLowerCase()
    orders = orders.filter((o) => o.status === want)
  }

  const total = orders.length
  const slice = orders.slice(0, limit)
  const unknownCount = orders.filter((o) => o.status === 'unknown').length

  const meta: ListAgentOrdersMeta = {
    count: total,
    limit,
    from: input.fromIso ?? null,
    to: input.toIso ?? null,
    dataSource: fromSupabase ? 'supabase' : 'gas_sheet',
    fetchedAt: new Date().toISOString(),
    sheetSyncedAt: fromSupabase ? null : (data as { syncedAt?: string }).syncedAt ?? null,
    unknownCount,
  }

  if (input.status === 'pending' || !input.status || input.status === 'all') {
    const mappedPending = orders.filter((o) => o.status === 'pending').length
    if (input.status === 'pending') {
      const gasFiltered = total
      const mismatch = gasFiltered !== mappedPending
      meta.pendingCrossCheck = {
        gasFilteredCount: gasFiltered,
        mappedPendingCount: mappedPending,
        mismatch,
        note: mismatch
          ? `GAS filter returned ${gasFiltered} rows but only ${mappedPending} map to pending — stale sync or bad status strings.`
          : null,
      }
    }
  }

  return {
    orders: slice,
    meta,
  }
}

export async function getAgentOrderDetail(id: string): Promise<AgentOrderDetail | null> {
  const data = await getLifestyleOrder(id, { business_id: DEFAULT_BUSINESS_ID })
  if (data.error || !data.order) return null
  return mapOrderDetail(data.order)
}

export function buildOrdersSummary(
  orders: AgentOrder[],
  period: SummaryPeriod,
): AgentOrdersSummary {
  const byStatus: Record<string, number> = {}
  let totalRevenue = 0

  for (const o of orders) {
    byStatus[o.status] = (byStatus[o.status] ?? 0) + 1
    totalRevenue += o.totalAmount
  }

  const totalOrders = orders.length

  return {
    period,
    totalOrders,
    totalRevenue: Math.round(totalRevenue),
    currency: 'BDT',
    avgOrderValue: totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0,
    byStatus,
    generatedAt: new Date().toISOString(),
  }
}

export async function getAgentOrdersSummary(period: SummaryPeriod): Promise<AgentOrdersSummary> {
  const range = getPeriodRangeDhaka(period)
  const { orders } = await listAgentOrders({
    startDate: range.startDate,
    endDate: range.endDate,
    limit: 500,
    fromIso: range.from.toISOString(),
    toIso: range.to.toISOString(),
  })
  return buildOrdersSummary(orders, period)
}
