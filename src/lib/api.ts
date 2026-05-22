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
import type { BusinessId } from '@/lib/businesses'
import { DEFAULT_BUSINESS_ID } from '@/lib/businesses'
import type {
  CditClient, CditProject, CditInvoice, CditPayment, CditDashboardData, CditClientDetail,
  FinancialReport,
} from '@/types/cdit'
import type { BusinessBranding, BrandAssetType } from '@/types/branding'
import type {
  ERPFinanceResponse,
  HREmployeesApi,
  HRPayrollListApi,
  HRDashboardApi,
} from '@/types/hr'
import type {
  TradingAccount,
  TradingAccountDetailResponse,
  TradingAccountInput,
  TradingAccountsResponse,
  TradingAnalyticsFilters,
  TradingAnalyticsResponse,
  TradingBkashSummaryInput,
  TradingBusinessSummaryResponse,
  TradingCapitalInput,
  TradingDashboardResponse,
  TradingExpenseInput,
  TradingEmployeeDailyReport,
  TradingEmployeeReportInput,
  TradingHrProfileInput,
  TradingHrResponse,
  TradingMutationResponse,
  TradingPerformanceScreenshot,
  TradingStaffSummaryResponse,
  TradingTradeActionInput,
  TradingTradeActionResponse,
  TradingTradeInput,
  TradingUser,
} from '@/types/trading'
import { readActorHeadersFromStorage } from '@/lib/actor-headers'

let _businessId: BusinessId = DEFAULT_BUSINESS_ID

/** Set by BusinessProvider — all API calls include business_id */
export function setApiBusinessId(id: BusinessId) {
  _businessId = id
}

export function getApiBusinessId(): BusinessId {
  return _businessId
}

function bizParams(p: Record<string, string> = {}): Record<string, string> {
  return { ...p, business_id: _businessId }
}

// ── Config ────────────────────────────────────────────────────────────────────
/** Default browser → Next.js API wait (most routes). */
const DEFAULT_CLIENT_TIMEOUT_MS = 25_000
/** Invoice PDF + GAS must exceed 60s budget per product requirement (browser abort). */
export const INVOICE_CLIENT_TIMEOUT_MS = 75_000

export type ApiFetchOptions = { timeoutMs?: number }

type ApiHealthEventDetail = {
  ok: boolean
  route: string
  status?: number
  critical?: boolean
}

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
    reportApiHealth({ ok: true, route: path, status: res.status })
    return data as T
  } catch (err) {
    clearTimeout(timer)
    const wrapped = wrapError_(err, path, timeoutMs)
    reportApiHealth({ ok: false, route: path, status: wrapped.status, critical: isCriticalApiFailure(wrapped) })
    throw wrapped
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
      headers: {
        'Content-Type': 'application/json',
        ...readActorHeadersFromStorage(),
      },
      body:    JSON.stringify(body),
      signal:  ctrl.signal,
      cache:   'no-store',
    })
    clearTimeout(timer)
    const data = await safeJson_<{ error?: string; ok?: boolean } & T>(res, `POST ${path}`)
    if (!res.ok || data.error) throw new APIError(data.error ?? `HTTP ${res.status}`, path, res.status)
    if (data && typeof data === 'object' && data.ok === false) {
      throw new APIError((data as { error?: string }).error || 'Request failed', path, res.status)
    }
    reportApiHealth({ ok: true, route: path, status: res.status })
    return data as T
  } catch (err) {
    clearTimeout(timer)
    const wrapped = wrapError_(err, path, timeoutMs)
    reportApiHealth({ ok: false, route: path, status: wrapped.status, critical: isCriticalApiFailure(wrapped) })
    throw wrapped
  }
}

async function apiPatch<T>(
  path: string,
  body: Record<string, unknown> = {},
  options?: ApiFetchOptions,
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    const res = await fetch(path, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...readActorHeadersFromStorage(),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store',
    })
    clearTimeout(timer)
    const data = await safeJson_<{ error?: string; ok?: boolean } & T>(res, `PATCH ${path}`)
    if (!res.ok || data.error) throw new APIError(data.error ?? `HTTP ${res.status}`, path, res.status)
    if (data && typeof data === 'object' && data.ok === false) {
      throw new APIError((data as { error?: string }).error || 'Request failed', path, res.status)
    }
    reportApiHealth({ ok: true, route: path, status: res.status })
    return data as T
  } catch (err) {
    clearTimeout(timer)
    const wrapped = wrapError_(err, path, timeoutMs)
    reportApiHealth({ ok: false, route: path, status: wrapped.status, critical: isCriticalApiFailure(wrapped) })
    throw wrapped
  }
}

async function apiDelete<T>(path: string, options?: ApiFetchOptions): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(path, {
      method: 'DELETE',
      headers: readActorHeadersFromStorage(),
      signal: ctrl.signal,
      cache: 'no-store',
    })
    clearTimeout(timer)
    const data = await safeJson_<{ error?: string } & T>(res, `DELETE ${path}`)
    if (!res.ok || data.error) throw new APIError(data.error ?? `HTTP ${res.status}`, path, res.status)
    reportApiHealth({ ok: true, route: path, status: res.status })
    return data as T
  } catch (err) {
    clearTimeout(timer)
    const wrapped = wrapError_(err, path, timeoutMs)
    reportApiHealth({ ok: false, route: path, status: wrapped.status, critical: isCriticalApiFailure(wrapped) })
    throw wrapped
  }
}

async function safeJson_<T>(res: Response, ctx: string): Promise<T> {
  const text = await res.text()
  if (!text.trim()) throw new APIError(`${ctx} returned empty response`, ctx)
  try { return JSON.parse(text) as T }
  catch { throw new APIError(`${ctx} returned non-JSON: ${text.slice(0, 80)}`, ctx) }
}

function xhrFormPost_(
  path: string,
  form: FormData,
  options: {
    headers: Record<string, string>
    timeoutMs: number
    signal?: AbortSignal
    onProgress?: (percent: number) => void
  },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', path)
    Object.entries(options.headers).forEach(([key, value]) => {
      if (value) xhr.setRequestHeader(key, value)
    })
    xhr.timeout = options.timeoutMs
    xhr.responseType = 'text'

    const onAbort = () => {
      xhr.abort()
      reject(new DOMException('Upload cancelled', 'AbortError'))
    }
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    xhr.upload.onprogress = event => {
      if (!options.onProgress || !event.lengthComputable) return
      options.onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)))
    }

    xhr.onload = () => {
      options.signal?.removeEventListener('abort', onAbort)
      resolve(
        new Response(xhr.responseText, {
          status: xhr.status,
          statusText: xhr.statusText,
        }),
      )
    }

    xhr.onerror = () => {
      options.signal?.removeEventListener('abort', onAbort)
      reject(new Error('Network error during upload'))
    }

    xhr.ontimeout = () => {
      options.signal?.removeEventListener('abort', onAbort)
      reject(new DOMException('Upload timed out', 'AbortError'))
    }

    xhr.onabort = () => {
      options.signal?.removeEventListener('abort', onAbort)
      reject(new DOMException('Upload cancelled', 'AbortError'))
    }

    xhr.send(form)
  })
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

function isCriticalApiFailure(err: APIError) {
  if (err.status === 408) return false
  if (err.status && err.status < 500) return false
  const message = err.message.toLowerCase()
  return !message.includes('timed out') && !message.includes('abort')
}

function reportApiHealth(detail: ApiHealthEventDetail) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<ApiHealthEventDetail>('alma:api-health', { detail }))
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

export type InventoryMutationInput = {
  action: 'edit' | 'archive' | 'restore' | 'adjust' | 'bulk_update'
  sku?: string
  items?: Array<Record<string, unknown>>
  data?: Record<string, unknown>
  reason?: string
  note?: string
  new_stock?: number
  buying_price?: number
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
  invoice?: InvoiceRegistryRecord
  /** True when invoice number already existed; `drive_url` may be a reused PDF link */
  duplicate?: boolean
  /** React PDF rendered; Google Drive save may still be running server-side */
  drive_sync?: 'pending' | 'complete'
}
export interface InvoiceRegistryRecord {
  id: string
  invoiceNumber: string
  orderId: string
  customerName: string
  customerPhone?: string | null
  businessId: string
  amount: unknown
  paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' | 'VOID'
  driveUrl?: string | null
  fileUrl?: string | null
  shareUrl?: string | null
  fileName?: string | null
  generatedById?: string | null
  generatedByName?: string | null
  createdAt: string
  updatedAt: string
  events?: Array<{
    id: string
    type: string
    actorName?: string | null
    note?: string | null
    createdAt: string
  }>
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
  inventory_mode?: 'single' | 'collection'
  collection_code?: string
  collection_type?: 'MEN' | 'WOMEN' | 'SINGLE' | 'CUSTOM'
  gender_type?: string
  bulk_rows?: Array<{
    sku: string
    collectionCode: string
    collectionType: string
    genderType: string
    sizeCategory?: string
    sizeValue?: string
    variantGroup?: string
    buyingPrice: number
    stockQty: number
    barcode?: string
    active?: boolean
    product?: string
    category?: string
  }>
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
  paid_amount?: number
  due_amount?: number
  estimated_profit?: number
  inventory_cost?: number
  courier_cost?: number
  items?: Array<{
    line_no: number
    product_code: string
    product: string
    category?: string
    size?: string
    variant?: string
    qty: number
    unit_price: number
    sell_price: number
    subtotal: number
    sku: string
    stock_sku?: string
    cogs?: number
    collection_code?: string
    collection_type?: string
    size_group?: string
    variant_group?: string
  }>
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
    get: (p?: { startDate?: string; endDate?: string }): Promise<DashboardData> =>
      apiGet('/api/dashboard', bizParams(p as Record<string, string>)),
  },

  orders: {
    /** GET /api/orders/orders → GAS ?route=orders&... */
    list: (p?: {
      status?: string; source?: string; payment?: string
      search?: string; limit?: string; offset?: string
      startDate?: string
      endDate?: string
    }): Promise<OrdersResponse> => apiGet('/api/orders/orders', bizParams(p as Record<string, string>)),

    /** GET /api/orders/orders?id=ALM-0001 → GAS ?route=order&id=... */
    get: (id: string): Promise<{ order: Order }> => apiGet('/api/orders/orders', { id }),
  },

  customers: {
    /** GET /api/customers → GAS ?route=customers&... */
    list: (p?: { search?: string; segment?: string; risk_level?: string }): Promise<CustomersResponse> =>
      apiGet('/api/customers', bizParams(p as Record<string, string>)),

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
    mutate: (payload: InventoryMutationInput): Promise<MutationOk & Record<string, unknown>> =>
      apiPost('/api/stock', payload),
  },

  finance: {
    get: (p?: { startDate?: string; endDate?: string }): Promise<ERPFinanceResponse> =>
      apiGet('/api/finance', bizParams(p as Record<string, string>)),
    report: (p?: { startDate?: string; endDate?: string }): Promise<FinancialReport> =>
      apiGet('/api/finance/report', bizParams(p as Record<string, string>)),
  },

  hr: {
    employees: (p?: { startDate?: string; endDate?: string }): Promise<HREmployeesApi> =>
      apiGet('/api/hr/employees', bizParams(p as Record<string, string>)),
    payroll: (p?: {
      emp_id?: string
      startDate?: string
      endDate?: string
    }): Promise<HRPayrollListApi> =>
      apiGet('/api/hr/payroll', bizParams(p as Record<string, string>)),
    dashboard: (p?: {
      startDate?: string
      endDate?: string
    }): Promise<HRDashboardApi> =>
      apiGet('/api/hr/dashboard', bizParams(p as Record<string, string>)),
    saveEmployee: (body: Record<string, unknown>): Promise<{ ok: boolean; emp_id?: string; error?: string }> =>
      apiPost('/api/hr/employees', { ...body, business_id: body.business_id || _businessId }),
    addPayroll: (body: Record<string, unknown>): Promise<{ ok: boolean; tx_id?: string; error?: string }> =>
      apiPost('/api/hr/payroll', { ...body, business_id: body.business_id || _businessId }),
  },

  audit: {
    list: (p?: { limit?: string }): Promise<{
      audit: Array<{
        timestamp: string
        route: string
        actor: string
        actor_role: string
        business_id: string
        entity_type: string
        entity_id: string
        summary: string
        detail_json: string
        status_flag: string
      }>
      total: number
    }> =>
      apiGet('/api/audit', bizParams(p as Record<string, string>)),
  },

  digital: {
    dashboard: (): Promise<CditDashboardData> =>
      apiGet('/api/digital/dashboard', bizParams()),
    clients: {
      list: (p?: { search?: string }): Promise<{ clients: CditClient[]; total: number }> =>
        apiGet('/api/digital/clients', bizParams(p as Record<string, string>)),
      detail: (id: string): Promise<CditClientDetail> =>
        apiGet('/api/digital/clients/' + encodeURIComponent(id), bizParams()),
      create: (client: Partial<CditClient>): Promise<{ ok: boolean; client_id?: string; client?: CditClient; error?: string }> =>
        apiPost('/api/digital/clients', { ...client, business_id: client.business_id || _businessId }),
    },
    projects: {
      list: (p?: { status?: string; search?: string; client_id?: string }): Promise<{ projects: CditProject[]; total: number }> =>
        apiGet('/api/digital/projects', bizParams(p as Record<string, string>)),
      create: (project: Partial<CditProject>): Promise<{ ok: boolean; project_id?: string; project: CditProject }> =>
        apiPost('/api/digital/projects', { ...project, business_id: _businessId }),
      update: (id: string, fields: Partial<CditProject>): Promise<{ ok: boolean }> =>
        apiPost('/api/digital/projects', { action: 'update', id, ...fields }),
    },
    invoices: {
      list: (p?: { status?: string; client_id?: string }): Promise<{ invoices: CditInvoice[]; total: number }> =>
        apiGet('/api/digital/invoices', bizParams(p as Record<string, string>)),
      create: (inv: Partial<CditInvoice>): Promise<{ ok: boolean; invoice_id?: string; invoice: CditInvoice }> =>
        apiPost('/api/digital/invoices', { ...inv, business_id: _businessId }),
      updateStatus: (id: string, status: string): Promise<{ ok: boolean }> =>
        apiPost('/api/digital/invoices', { action: 'update_status', id, status }),
      generatePdf: (id: string): Promise<{ ok: boolean; pdf_url?: string; error?: string }> =>
        apiPost('/api/digital/invoices/pdf', { invoice_id: id }, { timeoutMs: INVOICE_CLIENT_TIMEOUT_MS }),
    },
    payments: {
      list: (p?: { client_id?: string; project_id?: string; invoice_id?: string }): Promise<{ payments: CditPayment[] }> =>
        apiGet('/api/digital/payments', bizParams(p as Record<string, string>)),
      create: (p: Partial<CditPayment>): Promise<{ ok: boolean; payment_id?: string; payment: CditPayment }> =>
        apiPost('/api/digital/payments', { ...p, business_id: _businessId }),
    },
  },

  branding: {
    get: (businessId?: BusinessId): Promise<{ ok: boolean; branding: BusinessBranding }> =>
      apiGet('/api/branding', bizParams(businessId ? { business_id: businessId } : {})),
    getAll: (): Promise<{ ok: boolean; branding_by_business: Record<string, BusinessBranding> }> =>
      apiGet('/api/branding', { all: '1' }),
    save: (data: Partial<BusinessBranding>): Promise<{ ok: boolean; branding: BusinessBranding }> =>
      apiPost('/api/branding', { action: 'save', ...data, business_id: data.business_id || _businessId }),
    uploadAsset: (p: {
      asset_type: BrandAssetType
      data: string
      mime_type: string
      filename?: string
      business_id?: BusinessId
    }): Promise<{ ok: boolean; url?: string; branding?: BusinessBranding }> =>
      apiPost('/api/branding', { action: 'upload', ...p, business_id: p.business_id || _businessId }),
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
    get: (p?: { startDate?: string; endDate?: string }): Promise<DashboardData> =>
      apiGet('/api/analytics', bizParams(p as Record<string, string>)),
  },

  trading: {
    analytics: (p?: TradingAnalyticsFilters): Promise<TradingAnalyticsResponse> =>
      apiGet('/api/trading/analytics', p as Record<string, string>),
    dashboard: (): Promise<TradingDashboardResponse> =>
      apiGet('/api/trading/dashboard'),
    summary: (): Promise<TradingBusinessSummaryResponse> =>
      apiGet('/api/trading/summary'),
    staffSummary: (): Promise<TradingStaffSummaryResponse> =>
      apiGet('/api/trading/staff-summary'),
    hr: (): Promise<TradingHrResponse> =>
      apiGet('/api/trading/hr'),
    saveHrProfile: (payload: TradingHrProfileInput): Promise<{ ok: boolean; profile: unknown }> =>
      apiPost('/api/trading/hr', payload as Record<string, unknown>),
    employeeReports: (p?: { userId?: string; limit?: number }): Promise<{ reports: TradingEmployeeDailyReport[] }> =>
      apiGet('/api/trading/hr/reports', {
        userId: p?.userId || '',
        limit: String(p?.limit || ''),
      }),
    submitEmployeeReport: (payload: TradingEmployeeReportInput): Promise<{ ok: boolean; report: TradingEmployeeDailyReport }> =>
      apiPost('/api/trading/hr/reports', payload as Record<string, unknown>),
    accounts: (p?: { search?: string; status?: string }): Promise<TradingAccountsResponse> =>
      apiGet('/api/trading/accounts', {
        search: p?.search || '',
        status: p?.status || '',
      }),
    accountDetail: (id: string): Promise<TradingAccountDetailResponse> =>
      apiGet(`/api/trading/accounts/${encodeURIComponent(id)}/summary`),
    staff: (): Promise<{ staff: TradingUser[] }> =>
      apiGet('/api/trading/staff'),
    createAccount: (payload: TradingAccountInput): Promise<{ ok: boolean; account: TradingAccount }> =>
      apiPost('/api/trading/accounts', payload as Record<string, unknown>),
    updateAccount: (id: string, payload: Partial<TradingAccountInput> & { action?: 'update' | 'archive' }): Promise<{ ok: boolean; account: TradingAccount }> =>
      apiPatch(`/api/trading/accounts/${encodeURIComponent(id)}`, payload as Record<string, unknown>),
    submitTrade: (payload: TradingTradeInput): Promise<TradingMutationResponse> =>
      apiPost('/api/trading/trades', payload as Record<string, unknown>, { timeoutMs: 20_000 }),
    updateTrade: (id: string, payload: TradingTradeActionInput): Promise<TradingTradeActionResponse> =>
      apiPatch(`/api/trading/trades/${encodeURIComponent(id)}`, payload as Record<string, unknown>, { timeoutMs: 20_000 }),
    addExpense: (payload: TradingExpenseInput): Promise<TradingMutationResponse> =>
      apiPost('/api/trading/expenses', payload as Record<string, unknown>),
    addCapital: (payload: TradingCapitalInput): Promise<TradingMutationResponse> =>
      apiPost('/api/trading/capital', payload as Record<string, unknown>),
    addBkashSummary: (payload: TradingBkashSummaryInput): Promise<TradingMutationResponse> =>
      apiPost(`/api/trading/accounts/${encodeURIComponent(payload.tradingAccountId)}/bkash-summary`, payload as Record<string, unknown>),
    performanceScreenshots: (accountId: string, p?: { archived?: boolean; cursor?: string; limit?: number }): Promise<{ screenshots: TradingPerformanceScreenshot[]; nextCursor: string | null; archived: boolean }> =>
      apiGet(`/api/trading/accounts/${encodeURIComponent(accountId)}/performance`, {
        archived: p?.archived ? '1' : '',
        cursor: p?.cursor || '',
        limit: String(p?.limit || ''),
      }),
    uploadPerformanceScreenshot: async (
      accountId: string,
      file: File,
      payload: { shotDate?: string; note?: string; fingerprint?: string },
      options?: {
        onProgress?: (percent: number) => void
        signal?: AbortSignal
        timeoutMs?: number
      },
    ): Promise<{ ok: boolean; screenshot: TradingPerformanceScreenshot }> => {
      const path = `/api/trading/accounts/${encodeURIComponent(accountId)}/performance`
      const form = new FormData()
      form.set('file', file)
      if (payload.shotDate) form.set('shotDate', payload.shotDate)
      if (payload.note) form.set('note', payload.note)
      if (payload.fingerprint) form.set('fingerprint', payload.fingerprint)

      const timeoutMs = options?.timeoutMs ?? 120_000
      const headers = readActorHeadersFromStorage()

      const res =
        typeof XMLHttpRequest !== 'undefined'
          ? await xhrFormPost_(path, form, { headers, timeoutMs, signal: options?.signal, onProgress: options?.onProgress })
          : await fetch(path, {
              method: 'POST',
              body: form,
              cache: 'no-store',
              headers,
              signal: options?.signal,
            })

      const data = await safeJson_<{ error?: string; code?: string; ok: boolean; screenshot: TradingPerformanceScreenshot }>(
        res,
        'POST /api/trading/accounts/[id]/performance',
      )
      if (!res.ok || data.error) {
        throw new APIError(data.error ?? `HTTP ${res.status}`, path, res.status)
      }
      return data
    },
    volumeTargets: (p?: { date?: string; status?: string }): Promise<{ date: string; targets: unknown[]; canManage: boolean }> =>
      apiGet('/api/trading/volume-targets', { date: p?.date || '', status: p?.status || '' }),
    createVolumeTarget: (payload: Record<string, unknown>): Promise<{ ok: boolean; target: unknown }> =>
      apiPost('/api/trading/volume-targets', payload),
    updateVolumeTarget: (id: string, payload: Record<string, unknown>): Promise<{ ok: boolean; target: unknown }> =>
      apiPatch(`/api/trading/volume-targets/${encodeURIComponent(id)}`, payload),
    deleteVolumeTarget: (id: string): Promise<{ ok: boolean }> =>
      apiDelete(`/api/trading/volume-targets/${encodeURIComponent(id)}`),
    volumeTargetAction: (id: string, payload: Record<string, unknown>): Promise<{ ok: boolean; target: unknown }> =>
      apiPost(`/api/trading/volume-targets/${encodeURIComponent(id)}/actions`, payload),
    volumeTargetSettings: (): Promise<{ settings: { autoPenaltyEnabled: boolean; defaultPenaltyBdt: number }; canManage: boolean }> =>
      apiGet('/api/trading/volume-targets/settings'),
    updateVolumeTargetSettings: (payload: Record<string, unknown>): Promise<{ ok: boolean; settings: unknown }> =>
      apiPatch('/api/trading/volume-targets/settings', payload),
    volumeTargetAnalytics: (p?: { month?: string }): Promise<{ analytics?: unknown; summary?: unknown; canManage: boolean }> =>
      apiGet('/api/trading/volume-targets/analytics', { month: p?.month || '' }),
    volumeTargetAudits: (p?: { targetId?: string; limit?: number }): Promise<{ audits: unknown[] }> =>
      apiGet('/api/trading/volume-targets/audit', {
        targetId: p?.targetId || '',
        limit: String(p?.limit || ''),
      }),
    uploadAttachment: async (file: File): Promise<{ ok: boolean; attachment: { id: string; url: string; fileName: string } }> => {
      const form = new FormData()
      form.set('file', file)
      const res = await fetch('/api/trading/attachments', {
        method: 'POST',
        body: form,
        cache: 'no-store',
        headers: readActorHeadersFromStorage(),
      })
      const data = await safeJson_<{ error?: string; ok: boolean; attachment: { id: string; url: string; fileName: string } }>(res, 'POST /api/trading/attachments')
      if (!res.ok || data.error) throw new APIError(data.error ?? `HTTP ${res.status}`, '/api/trading/attachments', res.status)
      return data
    },
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
      apiPost('/api/orders/orders', { ...normalizeCreateOrderPayload(order), business_id: _businessId }),

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
    generateInvoice: async (id: string, options?: { allowRegenerate?: boolean }): Promise<GenerateInvoiceRes> => {
      const raw = await apiPost<GenerateInvoiceRes & { share_url?: string; duplicate?: boolean }>(
        '/api/invoice',
        { id, allow_regenerate: Boolean(options?.allowRegenerate) },
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
      date?: string
      title?: string
      category: string
      amount: number
      notes?: string
      note?: string
      vendor?: string
      payment_method?: string
      payment?: string
      payment_status?: string
      receipt_ref?: string
      receipt_attachment_id?: string
      attachment_url?: string
      recurring?: boolean
      expense_kind?: string
      exp_type?: string
    }): Promise<AddExpenseRes> =>
      apiPost('/api/finance', { ...expense, business_id: _businessId }),

    /** Create a Drive folder structure for an order → POST /api/orders/orders/field */
    createOrderFolder: (id: string): Promise<CreateOrderFolderRes> =>
      apiPost('/api/orders/orders/field', { id, field: 'create_folder', value: 1 }),
  },
}
