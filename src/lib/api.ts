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
/** Default browser → Next.js API wait (most routes). */
const DEFAULT_CLIENT_TIMEOUT_MS = 25_000
/** Invoice PDF + GAS must exceed 60s budget per product requirement (browser abort). */
export const INVOICE_CLIENT_TIMEOUT_MS = 75_000

export type ApiFetchOptions = { timeoutMs?: number }

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
    if (this.status === 408)
      return this.message.includes('Invoice')
        ? this.message
        : 'Request timed out — try again. For invoices, generation can take up to about a minute.'
    if (this.message.includes('not configured')) return 'API not connected — check .env.local'
    return this.message.replace(/^(GET|POST) \/api\/\S+ → /, '')
  }
}

// ── Core fetch helpers ────────────────────────────────────────────────────────

async function apiGet<T>(path: string, params: Record<string, string> = {}, options?: ApiFetchOptions): Promise<T> {
  const url = new URL(path, window.location.origin)
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') url.searchParams.set(k, v) })

  const timeoutMs = options?.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    const res  = await fetch(url.toString(), { signal: ctrl.signal, cache: 'no-store' })
    clearTimeout(timer)
    const data = await safeJson_<{ error?: string } & T>(res, `GET ${path}`)
    if (!res.ok || data.error) throw new APIError(data.error ?? `HTTP ${res.status}`, path, res.status)
    return data as T
  } catch (err) {
    clearTimeout(timer)
    throw wrapError_(err, path, timeoutMs)
  }
}

async function apiPost<T>(
  path: string,
  body: Record<string, unknown> = {},
  options?: ApiFetchOptions,
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

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
    throw wrapError_(err, path, timeoutMs)
  }
}

async function safeJson_<T>(res: Response, ctx: string): Promise<T> {
  const text = await res.text()
  if (!text.trim()) throw new APIError(`${ctx} returned empty response`, ctx)
  try { return JSON.parse(text) as T }
  catch { throw new APIError(`${ctx} returned non-JSON: ${text.slice(0, 80)}`, ctx) }
}

function wrapError_(err: unknown, route: string, timeoutMs?: number): APIError {
  if (err instanceof APIError) return err
  const msg = err instanceof Error ? err.message : String(err)
  const status = (err as APIError).status
  if (msg === 'AbortError' || msg.includes('aborted')) {
    const ms = timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS
    const hint =
      route === '/api/invoice'
        ? `Invoice generation timed out after ${Math.round(ms / 1000)}s — the server may still be working; wait, check Google Drive, then retry if the PDF is missing.`
        : `Request timed out after ${Math.round(ms / 1000)}s`
    return new APIError(hint, route, 408)
  }
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
    id: string
    sku?: string
    name: string
    category: string
    default_price: number
    default_cogs: number
    active: boolean
    notes: string
    updated_at: string
  }>
  total: number
  error?: string
}

export interface SupplierImportCommitResponse {
  ok: boolean
  created: string[]
  skipped: Array<{ sku: string; reason: string }>
  errors: Array<{ index?: number; sku?: string; message: string }>
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
export interface CreateProductRes extends MutationOk {
  product_id: string
  duplicate?: boolean
  stock?: { ok: boolean; reason?: string }
}
export interface GenerateInvoiceRes extends MutationOk {
  invoice_number: string
  drive_url?: string
  file_url?: string
  file_name?: string
  share_url?: string
  /** True when invoice number already existed; `drive_url` may be a reused PDF link */
  duplicate?: boolean
}
export interface NextInvoiceNumberRes {
  /** Normalized next invoice label (from GAS `next` or `invoice_number`) */
  invoice_number: string
  next?: string
}
interface AddExpenseRes           extends MutationOk { expense_id: string }
interface CreateOrderFolderRes    extends MutationOk { folder_url: string }

export type CreateProductInput = {
  name: string
  sku?: string
  category?: string
  default_price?: number
  default_cogs?: number
  notes?: string
  active?: boolean
  image_url?: string
  supplier?: string
  supplier_product_id?: string
  description?: string
  variants?: string[]
  variants_json?: string
  /** When true, GAS skips insert if product name already exists in PRODUCT MASTER */
  skip_duplicate_name_check?: boolean
  color?: string
  size?: string
  initial_stock?: number
  reorder_level?: number
  /** Default true: append matching row to 📦 STOCK CONTROL for Inventory list */
  sync_to_stock?: boolean
}

/**
 * Input for `api.mutations.createOrder`. Canonical fields match the ERP form; optional
 * legacy keys are coalesced when the canonical value is empty (GAS / older clients).
 */
export type CreateOrderInput = {
  customer?: string
  customer_name?: string
  phone?: string
  customer_phone?: string
  address?: string
  customer_address?: string
  product?: string
  product_name?: string
  category?: string
  size?: string
  qty: number
  unit_price: number
  sell_price?: number
  cogs?: number
  courier_charge?: number
  shipping_fee?: number
  discount?: number
  payment?: string
  payment_method?: string
  source: string
  status?: string
  courier?: string
  tracking_id?: string
  notes?: string
  sku?: string
}

/** Ensures GAS-required `payment` plus legacy alias keys are always present on the wire. */
export function normalizeCreateOrderPayload(order: CreateOrderInput): Record<string, unknown> {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const digits = (v: unknown) => str(v).replace(/\D/g, '')

  const customer = str(order.customer).trim() || str(order.customer_name).trim()
  const phone = digits(order.phone) || digits(order.customer_phone)
  const address = str(order.address).trim() || str(order.customer_address).trim()
  const product = str(order.product).trim() || str(order.product_name).trim()
  const paymentMethod = str(order.payment_method).trim() || str(order.payment).trim()

  return {
    ...order,
    customer,
    customer_name: customer,
    phone,
    customer_phone: phone,
    address,
    customer_address: address,
    product,
    product_name: product,
    payment: paymentMethod,
    payment_method: paymentMethod,
  }
}

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

  supplierImport: {
    /**
     * Chunked append to PRODUCT MASTER via GAS. Skips duplicates server-side.
     * @param timeoutMs allow long bulk runs (default 3 minutes)
     */
    commit: (
      payload: { items: Record<string, unknown>[]; skip_duplicate_names?: boolean },
      options?: ApiFetchOptions,
    ): Promise<SupplierImportCommitResponse> =>
      apiPost('/api/supplier-import/commit', payload, {
        timeoutMs: options?.timeoutMs ?? 180_000,
      }),
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
    /** Peek next AL-INV number — GET /api/invoice → GAS `next_invoice_num` */
    nextNumber: async (): Promise<NextInvoiceNumberRes> => {
      const d = await apiGet<{ next?: string; invoice_number?: string }>('/api/invoice')
      const invoice_number = (d.invoice_number || d.next || '').trim()
      if (!invoice_number) throw new APIError('Next invoice number unavailable from API', '/api/invoice')
      return { invoice_number, next: d.next }
    },
  },

  analytics: {
    get: (): Promise<DashboardData> => apiGet('/api/analytics'),
  },

  mutations: {
    /**
     * Create a new order — POST /api/orders/orders
     *
     * GAS `createOrder_` validates `payment` (not `payment_method`) and reads canonical
     * `customer`, `phone`, `address`, `product`. The payload is normalized so both
     * canonical and legacy alias keys are always sent.
     */
    createOrder: (order: CreateOrderInput): Promise<CreateOrderRes> =>
      apiPost('/api/orders/orders', normalizeCreateOrderPayload(order)),

    /** Change order status → POST /api/orders/orders/status */
    updateStatus: (id: string, status: OrderStatus): Promise<UpdateStatusRes> =>
      apiPost('/api/orders/orders/status', { id, status }),

    /** Write tracking ID → POST /api/orders/orders/tracking */
    updateTracking: (id: string, tracking_id: string, courier?: string): Promise<UpdateTrackingRes> =>
      apiPost('/api/orders/orders/tracking', { id, tracking_id, courier }),

    /** Write any writable field → POST /api/orders/orders/field */
    updateField: (id: string, field: string, value: string | number): Promise<MutationOk> =>
      apiPost('/api/orders/orders/field', { id, field, value }),

    /** Generate a PDF invoice → POST /api/invoice (GAS returns file_url + drive_url) */
    generateInvoice: async (id: string): Promise<GenerateInvoiceRes> => {
      const raw = await apiPost<GenerateInvoiceRes & { share_url?: string; duplicate?: boolean }>(
        '/api/invoice',
        { id },
        { timeoutMs: INVOICE_CLIENT_TIMEOUT_MS },
      )
      const url = (raw.drive_url || raw.file_url || raw.share_url || '').trim()
      return {
        ...raw,
        ok: raw.ok !== false,
        drive_url: url,
        file_url: raw.file_url || url,
        share_url: raw.share_url || url,
        duplicate: Boolean(raw.duplicate),
      }
    },

    /** Create / upsert a customer → POST /api/customers */
    createCustomer: (
      name: string,
      phone: string,
      address?: string,
      district?: string,
      source?: string,
    ): Promise<CreateCustomerRes> =>
      apiPost('/api/customers', { name, phone, address, district, source }),

    /** Add a product to PRODUCT MASTER (+ optional STOCK row) → POST /api/products */
    createProduct: (p: CreateProductInput): Promise<CreateProductRes> => apiPost('/api/products', p as Record<string, unknown>),

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
