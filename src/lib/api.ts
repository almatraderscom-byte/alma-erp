/**
 * src/lib/api.ts
 *
 * Browser-side API client for the Alma Lifestyle ERP.
 *
 * All calls go through Next.js Route Handlers (/api/*) which run server-side.
 * This keeps API_SECRET out of the browser bundle entirely.
 *
 * Pattern:
 *   Component → useXxx hook → api.xxx() → fetch('/api/...') → Next.js handler
 *               → serverPost/serverGet → Google Apps Script → Google Sheets
 */

import type { Order, Customer, OrderStatus, DashboardData, StockItem, LogEvent } from '@/types'

// ── Config ────────────────────────────────────────────────────────────────────
const TIMEOUT_MS = 15_000

// ── Error type ────────────────────────────────────────────────────────────────
export class APIError extends Error {
  constructor(
    message: string,
    public readonly route: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'APIError'
  }

  get userMessage(): string {
    if (this.status === 401) return 'Authentication error — check API_SECRET'
    if (this.status === 408) return 'Request timed out — try again'
    if (this.message.includes('not configured')) return 'API not connected — check .env.local'
    return this.message.replace(/^(GET|POST) \/api\/\S+ → /, '')
  }
}

// ── Core fetch helpers ────────────────────────────────────────────────────────

async function apiGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(path, window.location.origin)
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') url.searchParams.set(k, v) })

  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)

  try {
    const res  = await fetch(url.toString(), { signal: ctrl.signal, cache: 'no-store' })
    clearTimeout(timer)
    const data = await safeJson_<{ error?: string } & T>(res, `GET ${path}`)
    if (!res.ok || data.error) throw new APIError(data.error ?? `HTTP ${res.status}`, path, res.status)
    return data as T
  } catch (err) {
    clearTimeout(timer)
    throw wrapError_(err, path)
  }
}

async function apiPost<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)

  try {
    const res  = await fetch(path, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  ctrl.signal,
      cache:   'no-store',
    })
    clearTimeout(timer)
    const data = await safeJson_<{ error?: string } & T>(res, `POST ${path}`)
    if (!res.ok || data.error) throw new APIError(data.error ?? `HTTP ${res.status}`, path, res.status)
    return data as T
  } catch (err) {
    clearTimeout(timer)
    throw wrapError_(err, path)
  }
}

async function safeJson_<T>(res: Response, ctx: string): Promise<T> {
  const text = await res.text()
  if (!text.trim()) throw new APIError(`${ctx} returned empty response`, ctx)
  try { return JSON.parse(text) as T }
  catch { throw new APIError(`${ctx} returned non-JSON: ${text.slice(0, 80)}`, ctx) }
}

function wrapError_(err: unknown, route: string): APIError {
  if (err instanceof APIError) return err
  const msg = err instanceof Error ? err.message : String(err)
  const status = (err as APIError).status
  if (msg === 'AbortError' || msg.includes('aborted')) return new APIError('Request timed out', route, 408)
  return new APIError(msg, route, status)
}

// ── Response types ─────────────────────────────────────────────────────────────

export interface OrdersResponse {
  orders:  Order[]
  summary: {
    total:         number
    total_revenue: number
    total_profit:  number
    by_status:     Record<string, number>
  }
}

export interface CustomersResponse {
  customers: Customer[]
  total:     number
}

export interface ProductsResponse {
  products: Array<{
    id: string; name: string; category: string
    default_price: number; default_cogs: number
    active: boolean; notes: string; updated_at: string
  }>
  total: number
}

export interface StockResponse {
  items:   StockItem[]
  summary: {
    total_skus:  number
    low_stock:   number
    out_of_stock: number
    total_value: number
  }
}

export interface FinanceData {
  cash_balance:    number
  total_income:    number
  total_expense:   number
  net_profit:      number
  expense_by_cat:  Record<string, number>
  recent_expenses: Array<{ date: string; category: string; amount: number; notes: string }>
}

export interface LogResponse {
  events: LogEvent[]
  total:  number
}

export type SlaAlert = {
  id: string; customer: string; sla_status: string; days_pending: number; days_in_transit: number
}

interface MutationOk              { ok: boolean }
interface CreateOrderRes          extends MutationOk { order_id: string; profit: number }
interface UpdateStatusRes         extends MutationOk { order_id: string; old_status: string; new_status: string }
interface UpdateTrackingRes       extends MutationOk { order_id: string; tracking_id: string; auto_shipped: boolean }
interface CreateCustomerRes       extends MutationOk { customer_id: string; created: boolean }
interface CreateProductRes        extends MutationOk { product_id: string }
interface GenerateInvoiceRes      extends MutationOk { invoice_number: string; drive_url: string }
interface NextInvoiceNumberRes    { invoice_number: string }
interface AddExpenseRes           extends MutationOk { expense_id: string }
interface CreateOrderFolderRes    extends MutationOk { folder_url: string }

// ── Public API ─────────────────────────────────────────────────────────────────
export const api = {

  dashboard: {
    get: (): Promise<DashboardData> => apiGet('/api/dashboard'),
  },

  orders: {
    /** GET /api/orders/orders → GAS ?route=orders&... */
    list: (p?: {
      status?: string; source?: string; payment?: string
      search?: string; limit?: string; offset?: string
    }): Promise<OrdersResponse> => apiGet('/api/orders/orders', p as Record<string, string>),

    /** GET /api/orders/orders?id=ALM-0001 → GAS ?route=order&id=... */
    get: (id: string): Promise<{ order: Order }> => apiGet('/api/orders/orders', { id }),
  },

  customers: {
    /** GET /api/customers → GAS ?route=customers&... */
    list: (p?: { search?: string; segment?: string; risk_level?: string }): Promise<CustomersResponse> =>
      apiGet('/api/customers', p as Record<string, string>),

    /** GET /api/customers?name=... → GAS ?route=customer&name=... */
    get: (name: string): Promise<{ customer: Customer; orders: Partial<Order>[] }> =>
      apiGet('/api/customers', { name }),
  },

  products: {
    list: (): Promise<ProductsResponse> => apiGet('/api/products'),
  },

  stock: {
    list: (): Promise<StockResponse> => apiGet('/api/stock'),
  },

  finance: {
    get: (): Promise<FinanceData> => apiGet('/api/finance'),
  },

  log: {
    recent: (limit = 100): Promise<LogResponse> =>
      apiGet('/api/log', { limit: String(limit) }),
  },

  sla: {
    /** Re-uses the dashboard endpoint — sla_breaches are part of the dashboard payload */
    alerts: (): Promise<{ alerts: SlaAlert[] }> =>
      apiGet<DashboardData>('/api/dashboard').then(d => ({ alerts: d.sla_breaches ?? [] })),
  },

  invoice: {
    nextNumber: (): Promise<NextInvoiceNumberRes> => apiGet('/api/invoice'),
  },

  analytics: {
    get: (): Promise<DashboardData> => apiGet('/api/analytics'),
  },

  mutations: {
    /**
     * Create a new order — POST /api/orders/orders
     * Field names must match GAS create_order handler exactly.
     */
    createOrder: (order: {
      customer:       string
      phone:          string
      address?:       string
      product:        string
      category?:      string
      size?:          string
      qty:            number
      unit_price:     number
      sell_price?:    number
      cogs?:          number
      courier_charge?: number
      shipping_fee?:  number
      discount?:      number
      payment:        string
      source:         string
      status?:        string
      courier?:       string
      tracking_id?:   string
      notes?:         string
      sku?:           string
    }): Promise<CreateOrderRes> => apiPost('/api/orders/orders', order as Record<string, unknown>),

    /** Change order status → POST /api/orders/orders/status */
    updateStatus: (id: string, status: OrderStatus): Promise<UpdateStatusRes> =>
      apiPost('/api/orders/orders/status', { id, status }),

    /** Write tracking ID → POST /api/orders/orders/tracking */
    updateTracking: (id: string, tracking_id: string, courier?: string): Promise<UpdateTrackingRes> =>
      apiPost('/api/orders/orders/tracking', { id, tracking_id, courier }),

    /** Write any writable field → POST /api/orders/orders/field */
    updateField: (id: string, field: string, value: string | number): Promise<MutationOk> =>
      apiPost('/api/orders/orders/field', { id, field, value }),

    /** Generate a PDF invoice → POST /api/invoice */
    generateInvoice: (id: string): Promise<GenerateInvoiceRes> =>
      apiPost('/api/invoice', { id }),

    /** Create / upsert a customer → POST /api/customers */
    createCustomer: (
      name: string,
      phone: string,
      address?: string,
      district?: string,
      source?: string,
    ): Promise<CreateCustomerRes> =>
      apiPost('/api/customers', { name, phone, address, district, source }),

    /** Add a product to the catalog → POST /api/products */
    createProduct: (p: {
      name: string; category?: string; default_price?: number; default_cogs?: number; notes?: string
    }): Promise<CreateProductRes> => apiPost('/api/products', p),

    /** Append to the Expense Ledger → POST /api/finance */
    addExpense: (expense: {
      date?: string; category: string; amount: number; notes?: string
    }): Promise<AddExpenseRes> =>
      apiPost('/api/finance', expense),

    /** Create a Drive folder structure for an order → POST /api/orders/orders/field */
    createOrderFolder: (id: string): Promise<CreateOrderFolderRes> =>
      apiPost('/api/orders/orders/field', { id, field: 'create_folder', value: 1 }),
  },
}
