/**
 * ALMA LIFESTYLE ERP — GOOGLE SHEETS API CLIENT
 *
 * All data comes from the live Apps Script Web App.
 * There is no mock or fallback data. When the sheet is empty
 * the API returns empty arrays and the UI shows an empty state.
 */

import type {
  Order, Customer, StockItem, DashboardData, LogEvent, OrderStatus,
} from '@/types'

// ── Config ────────────────────────────────────────────────────────────────
const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? ''
const SECRET   = process.env.API_SECRET ?? 'alma-dev-secret'

const TIMEOUT_MS  = 15_000
const MAX_RETRIES = 2

// ── In-flight deduplication ───────────────────────────────────────────────
const inflight = new Map<string, Promise<unknown>>()

// ── Error class ───────────────────────────────────────────────────────────
export class APIError extends Error {
  constructor(
    message: string,
    public readonly route: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'APIError'
  }

  get retryable(): boolean {
    return !this.status || this.status >= 500 || this.status === 408
  }

  get userMessage(): string {
    if (this.status === 401) return 'Authentication failed — check API_SECRET'
    if (this.status === 408) return 'Request timed out — Google Sheets may be slow'
    if (this.message.includes('empty response')) return 'No data received — try refreshing'
    return this.message.replace(/^(GET|POST) \S+ → /, '')
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// ── Core GET ──────────────────────────────────────────────────────────────
async function gasGet<T>(
  route: string,
  params: Record<string, string> = {},
  opts: { revalidate?: number } = {},
): Promise<T> {
  if (!BASE_URL) throw new APIError('API URL not configured — set NEXT_PUBLIC_API_URL in .env.local', route)

  const url = new URL(BASE_URL)
  url.searchParams.set('route', route)
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') url.searchParams.set(k, v) })
  const key = url.toString()

  if (inflight.has(key)) return inflight.get(key) as Promise<T>

  async function attempt(n: number): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url.toString(), {
        method: 'GET',
        signal: controller.signal,
        next: opts.revalidate !== undefined ? { revalidate: opts.revalidate } : undefined,
        redirect: 'follow',
      })
      clearTimeout(timer)
      if (!res.ok) throw new APIError(`GET ${route} → HTTP ${res.status}`, route, res.status)
      const text = await res.text()
      if (!text.trim()) {
        if (n < MAX_RETRIES) { await sleep(500 * n); return attempt(n + 1) }
        throw new APIError(`GET ${route} → empty response`, route)
      }
      let data: { error?: string } & T
      try { data = JSON.parse(text) } catch { throw new APIError(`GET ${route} → invalid JSON`, route) }
      if (data.error) throw new APIError(`GET ${route} → ${data.error}`, route)
      return data as T
    } catch (err) {
      clearTimeout(timer)
      if (err instanceof APIError) throw err
      if ((err as Error).name === 'AbortError') throw new APIError(`GET ${route} → timeout`, route, 408)
      if (n < MAX_RETRIES) { await sleep(400 * n); return attempt(n + 1) }
      throw new APIError(`GET ${route} → ${(err as Error).message}`, route)
    }
  }

  const p = attempt(1).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

// ── Core POST ─────────────────────────────────────────────────────────────
async function gasPost<T>(
  route: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  if (!BASE_URL) throw new APIError('API URL not configured', route)

  for (let n = 1; n <= MAX_RETRIES; n++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route, secret: SECRET, ...payload }),
        signal: controller.signal,
        redirect: 'follow',
        cache: 'no-store',
      })
      clearTimeout(timer)
      if (!res.ok) throw new APIError(`POST ${route} → HTTP ${res.status}`, route, res.status)
      const text = await res.text()
      if (!text.trim()) throw new APIError(`POST ${route} → empty response`, route)
      let data: { error?: string } & T
      try { data = JSON.parse(text) } catch { throw new APIError(`POST ${route} → invalid JSON`, route) }
      if (data.error) throw new APIError(`POST ${route} → ${data.error}`, route)
      return data as T
    } catch (err) {
      clearTimeout(timer)
      if (err instanceof APIError) throw err
      if ((err as Error).name === 'AbortError') throw new APIError(`POST ${route} timeout`, route, 408)
      if (n < MAX_RETRIES) { await sleep(400 * n); continue }
      throw new APIError(`POST ${route} → ${(err as Error).message}`, route)
    }
  }
  throw new APIError(`POST ${route} failed`, route)
}

// ── Response types ────────────────────────────────────────────────────────
interface OrdersResponse {
  orders: Order[]
  summary: { total: number; total_revenue: number; total_profit: number; by_status: Record<string, number> }
}
interface CustomersResponse {
  customers: Customer[]
  summary: { total: number; by_segment: Record<string, number>; by_risk: Record<string, number>; total_revenue: number; avg_clv: number }
}
interface StockResponse {
  items: StockItem[]
  summary: { total_skus: number; total_value: number; total_sell_val: number; low_stock: number; out_of_stock: number }
}
interface MutationOk { ok: boolean }
interface CreateOrderResponse  extends MutationOk { order_id: string; row: number }
interface StatusResponse       extends MutationOk { old_status: string; new_status: string; order_id: string }
interface TrackingResponse     extends MutationOk { auto_shipped: boolean; tracking_id: string }
interface InvoiceResponse      extends MutationOk { invoice_number: string; file_url: string; file_name: string }
interface ExpenseResponse      extends MutationOk { exp_id: string; row: number }
interface CustomerCreateResponse extends MutationOk { profile_row: number }
interface FolderResponse       extends MutationOk { folder_url: string }
interface SlaResponse { breaches: Array<{ id: string; customer: string; sla_status: string; days_pending: number; days_in_transit: number; courier: string; tracking_id: string }>; count: number }
interface LogResponse          { events: LogEvent[] }
interface FinanceResponse      { total_expenses: number; cash_balance: number; by_category: Record<string, number>; by_type: Record<string, number>; recent_expenses: unknown[] }
interface InvoiceNumResponse   { next: string }

// ── Public API ────────────────────────────────────────────────────────────
export const api = {

  orders: {
    list: (p?: { status?: string; source?: string; payment?: string; search?: string; limit?: string }) =>
      gasGet<OrdersResponse>('orders', p as Record<string, string>, { revalidate: 30 }),

    get: (id: string) =>
      gasGet<{ order: Order }>('order', { id }, { revalidate: 0 }),
  },

  dashboard: {
    get: () => gasGet<DashboardData>('dashboard', {}, { revalidate: 30 }),
  },

  customers: {
    list: (p?: { segment?: string; risk_level?: string; search?: string }) =>
      gasGet<CustomersResponse>('customers', p as Record<string, string>, { revalidate: 60 }),

    get: (name: string) =>
      gasGet<{ customer: Customer; orders: Order[] }>('customer', { name }, { revalidate: 0 }),
  },

  stock: {
    list: () => gasGet<StockResponse>('stock', {}, { revalidate: 120 }),
  },

  finance: {
    get: () => gasGet<FinanceResponse>('finance', {}, { revalidate: 60 }),
  },

  courier: {
    list: () => gasGet<{ shipments: unknown[] }>('courier', {}, { revalidate: 30 }),
  },

  log: {
    recent: (limit = 50) => gasGet<LogResponse>('log', { limit: String(limit) }, { revalidate: 30 }),
  },

  sla: {
    alerts: () => gasGet<SlaResponse>('sla_alerts', {}, { revalidate: 60 }),
  },

  invoice: {
    nextNumber: () => gasGet<InvoiceNumResponse>('next_invoice_num', {}, { revalidate: 0 }),
  },

  analytics: {
    get: () => gasGet<DashboardData & {
      monthly_trend: Array<{ month: string; revenue: number; profit: number; orders: number; cogs: number }>
      courier_stats: Record<string, { orders: number; delivered: number; returned: number; revenue: number }>
      expense_by_cat: Record<string, number>
      total_expenses: number
      cash_balance: number
    }>('analytics', {}, { revalidate: 60 }),
  },

  mutations: {
    createOrder: (order: {
      customer: string; phone: string; address?: string; product: string; category: string
      qty: number; unit_price: number; payment: string; source: string; status?: string
      size?: string; discount?: number; add_discount?: number; adv_cost?: number
      adv_platform?: string; shipping_fee?: number; cogs?: number; courier_charge?: number
      other_costs?: number; courier?: string; notes?: string; handled_by?: string; sku?: string
    }) => gasPost<CreateOrderResponse>('create_order', order),

    updateStatus: (id: string, status: OrderStatus) =>
      gasPost<StatusResponse>('update_status', { id, status }),

    updateTracking: (id: string, tracking_id: string, courier?: string, tracking_status?: string) =>
      gasPost<TrackingResponse>('update_tracking', { id, tracking_id, courier, tracking_status }),

    updateField: (id: string, field: string, value: string | number) =>
      gasPost<MutationOk>('update_field', { id, field, value }),

    addExpense: (expense: { category: string; amount: number; sub_cat?: string; exp_type?: string; description?: string; vendor?: string; payment?: string; notes?: string; linked_order?: string }) =>
      gasPost<ExpenseResponse>('add_expense', expense),

    generateInvoice: (id: string) =>
      gasPost<InvoiceResponse>('generate_invoice', { id }),

    createOrderFolder: (id: string) =>
      gasPost<FolderResponse>('create_order_folder', { id }),

    createCustomer: (name: string, phone: string, address?: string, district?: string, source?: string) =>
      gasPost<CustomerCreateResponse>('create_customer', { name, phone, address, district, source }),

    backfillSla: () => gasPost<MutationOk>('backfill_sla', {}),
  },
}
