/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  ALMA LIFESTYLE ERP — LIVE GOOGLE SHEETS API CLIENT                    ║
 * ║  Connected to: script.google.com (Apps Script Web App)                 ║
 * ║                                                                          ║
 * ║  Key behaviours:                                                         ║
 * ║  • GET  requests → query params on BASE_URL, no-cors not needed         ║
 * ║  • POST requests → JSON body, secret field required by server           ║
 * ║  • GAS Web Apps return 302 → fetch follows to the real JSON             ║
 * ║  • Automatic retry (×2) on network failure                              ║
 * ║  • In-flight deduplication: identical GETs share one pending promise    ║
 * ║  • Falls back to mock data when NEXT_PUBLIC_API_URL is not set          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import type {
  Order, Customer, StockItem, DashboardData, LogEvent, OrderStatus,
} from '@/types'
import {
  MOCK_ORDERS, MOCK_CUSTOMERS, MOCK_STOCK, MOCK_DASHBOARD,
} from './data'

// ── Config ─────────────────────────────────────────────────────────────────
const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? ''
const SECRET   = process.env.API_SECRET ?? 'alma-dev-secret'

/**
 * True  → live Google Sheets API
 * False → mock data (URL not configured or still has placeholder)
 */
export const IS_LIVE = Boolean(BASE_URL) && !BASE_URL.includes('YOUR_DEPLOYMENT')

const TIMEOUT_MS  = 15_000   // GAS cold-starts can be slow
const MAX_RETRIES = 2

// ── In-flight request deduplication ────────────────────────────────────────
// Prevents multiple identical GET requests fired in the same tick (e.g.
// React StrictMode double-invoking hooks) from hitting the API twice.
const inflight = new Map<string, Promise<unknown>>()

// ── Core GET ───────────────────────────────────────────────────────────────

/**
 * Fire a GET request to the Apps Script Web App.
 *
 * Google Apps Script Web Apps:
 *  - Respond with ContentService JSON output
 *  - The fetch follows 302 redirects automatically
 *  - No preflight CORS needed for GETs from server components
 *  - From the browser the response is opaque unless GAS sets CORS headers;
 *    we proxy all calls through Next.js route handlers to avoid this
 */
async function gasGet<T>(
  route: string,
  params: Record<string, string> = {},
  opts: { revalidate?: number } = {}
): Promise<T> {
  const url = new URL(BASE_URL)
  url.searchParams.set('route', route)
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') url.searchParams.set(k, v) })
  const key = url.toString()

  // Return existing in-flight request if one is already pending
  if (inflight.has(key)) return inflight.get(key) as Promise<T>

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  const attempt = async (attempt: number): Promise<T> => {
    try {
      const res = await fetch(url.toString(), {
        method: 'GET',
        signal: controller.signal,
        // Next.js ISR cache tag
        next: opts.revalidate !== undefined ? { revalidate: opts.revalidate } : undefined,
        // redirect: 'follow' is the default, GAS redirects are handled
        redirect: 'follow',
      })

      clearTimeout(timer)

      if (!res.ok) {
        throw new APIError(`GET ${route} → HTTP ${res.status}`, route, res.status)
      }

      const text = await res.text()

      // GAS sometimes returns empty body on cold start
      if (!text.trim()) {
        if (attempt < MAX_RETRIES) {
          await sleep(500 * attempt)
          return attempt + 1 as unknown as T  // recurse via outer
        }
        throw new APIError(`GET ${route} → empty response`, route)
      }

      let data: { error?: string } & T
      try {
        data = JSON.parse(text)
      } catch {
        throw new APIError(`GET ${route} → invalid JSON: ${text.slice(0, 120)}`, route)
      }

      if (data.error) throw new APIError(`GET ${route} → ${data.error}`, route)

      return data as T
    } catch (err) {
      clearTimeout(timer)
      if (err instanceof APIError) throw err
      if ((err as Error).name === 'AbortError') throw new APIError(`GET ${route} → timeout after ${TIMEOUT_MS}ms`, route, 408)
      if (attempt < MAX_RETRIES) {
        await sleep(400 * attempt)
        return gasGet<T>(route, params, opts)
      }
      throw new APIError(`GET ${route} → ${(err as Error).message}`, route)
    }
  }

  const p = attempt(1).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

// ── Core POST ──────────────────────────────────────────────────────────────

/**
 * Fire a POST request to the Apps Script Web App.
 *
 * GAS POST notes:
 *  - Body must be JSON string in e.postData.contents
 *  - Content-Type must be application/json
 *  - secret field authenticated server-side against Script Properties
 *  - Never cached — always fresh
 */
async function gasPost<T>(
  route: string,
  payload: Record<string, unknown> = {}
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  const body = JSON.stringify({ route, secret: SECRET, ...payload })

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
        redirect: 'follow',
        cache: 'no-store',
      })

      clearTimeout(timer)

      if (!res.ok) throw new APIError(`POST ${route} → HTTP ${res.status}`, route, res.status)

      const text = await res.text()
      if (!text.trim()) throw new APIError(`POST ${route} → empty response`, route)

      let data: { error?: string } & T
      try { data = JSON.parse(text) }
      catch { throw new APIError(`POST ${route} → invalid JSON`, route) }

      if (data.error) throw new APIError(`POST ${route} → ${data.error}`, route)

      return data as T
    } catch (err) {
      clearTimeout(timer)
      if (err instanceof APIError) throw err
      if ((err as Error).name === 'AbortError') throw new APIError(`POST ${route} timeout`, route, 408)
      if (attempt < MAX_RETRIES) { await sleep(400 * attempt); continue }
      throw new APIError(`POST ${route} → ${(err as Error).message}`, route)
    }
  }

  throw new APIError(`POST ${route} failed after ${MAX_RETRIES} attempts`, route)
}

// ── Error class ─────────────────────────────────────────────────────────────

export class APIError extends Error {
  constructor(
    message: string,
    public readonly route: string,
    public readonly status?: number
  ) {
    super(message)
    this.name = 'APIError'
  }

  /** True if the error is likely transient (worth retrying) */
  get retryable(): boolean {
    return !this.status || this.status >= 500 || this.status === 408
  }

  /** Human-readable for toast notifications */
  get userMessage(): string {
    if (this.status === 401) return 'Authentication failed — check API_SECRET'
    if (this.status === 408) return 'Request timed out — Google Sheets may be slow'
    if (this.message.includes('empty response')) return 'No data received — try refreshing'
    return this.message.replace(/^(GET|POST) \S+ → /, '')
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// ── Response type definitions ───────────────────────────────────────────────

interface OrdersResponse {
  orders: Order[]
  summary: {
    total: number
    total_revenue: number
    total_profit: number
    by_status: Record<string, number>
  }
}

interface CustomersResponse {
  customers: Customer[]
  summary: {
    total: number
    by_segment: Record<string, number>
    by_risk: Record<string, number>
    total_revenue: number
    avg_clv: number
  }
}

interface StockResponse {
  items: StockItem[]
  summary: {
    total_skus: number
    total_value: number
    total_sell_val: number
    low_stock: number
    out_of_stock: number
  }
}

interface MutationResponse { ok: boolean }
interface CreateOrderResponse extends MutationResponse { order_id: string; row: number }
interface StatusResponse extends MutationResponse { old_status: string; new_status: string; order_id: string }
interface TrackingResponse extends MutationResponse { auto_shipped: boolean; tracking_id: string }
interface InvoiceResponse extends MutationResponse { invoice_number: string; file_url: string; file_name: string }
interface ExpenseResponse extends MutationResponse { exp_id: string; row: number }
interface CustomerCreateResponse extends MutationResponse { profile_row: number }
interface FolderResponse extends MutationResponse { folder_url: string }
interface SlaResponse { breaches: Array<{ id: string; customer: string; sla_status: string; days_pending: number; days_in_transit: number; courier: string; tracking_id: string }>; count: number }
interface LogResponse { events: LogEvent[] }
interface FinanceResponse { total_expenses: number; cash_balance: number; by_category: Record<string, number>; by_type: Record<string, number>; recent_expenses: unknown[] }
interface InvoiceNumResponse { next: string }

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  PUBLIC API — all calls route through gasGet / gasPost when IS_LIVE,   ║
// ║  or through getMock / postMock when running locally without credentials ║
// ╚══════════════════════════════════════════════════════════════════════════╝

export const api = {

  // ── READ ──────────────────────────────────────────────────────────────────

  orders: {
    /**
     * GET ?route=orders[&status=][&source=][&payment=][&search=][&limit=][&offset=]
     * Returns all matching orders + aggregated summary.
     * Cached 30s on the Next.js edge.
     */
    list: (p?: {
      status?: string; source?: string; payment?: string
      search?: string; limit?: string; offset?: string
    }): Promise<OrdersResponse> =>
      IS_LIVE
        ? gasGet<OrdersResponse>('orders', p as Record<string, string>, { revalidate: 30 })
        : Promise.resolve(mockOrders(p)),

    /**
     * GET ?route=order&id=AL-0001
     * Full detail for one order row (44 fields + computed margin_pct).
     * Never cached — always fresh for the detail drawer.
     */
    get: (id: string): Promise<{ order: Order }> =>
      IS_LIVE
        ? gasGet<{ order: Order }>('order', { id }, { revalidate: 0 })
        : Promise.resolve({ order: MOCK_ORDERS.find(o => o.id === id) ?? MOCK_ORDERS[0] }),
  },

  dashboard: {
    /**
     * GET ?route=dashboard
     * Computed KPIs directly from ORDERS sheet — never uses cached formula values.
     * Cached 30s; the useQuery hook re-polls every 60s for live feel.
     */
    get: (): Promise<DashboardData> =>
      IS_LIVE
        ? gasGet<DashboardData>('dashboard', {}, { revalidate: 30 })
        : Promise.resolve(MOCK_DASHBOARD),
  },

  customers: {
    /**
     * GET ?route=customers[&segment=][&risk_level=][&search=]
     * All customer profiles from the CUSTOMERS sheet (Phase 5).
     * Cached 60s — customer data changes less frequently than orders.
     */
    list: (p?: { segment?: string; risk_level?: string; search?: string }): Promise<CustomersResponse> =>
      IS_LIVE
        ? gasGet<CustomersResponse>('customers', p as Record<string, string>, { revalidate: 60 })
        : Promise.resolve(mockCustomers(p)),

    /**
     * GET ?route=customer&name=Nusrat+Jahan
     * Single customer profile + all their orders.
     */
    get: (name: string): Promise<{ customer: Customer; orders: Order[] }> =>
      IS_LIVE
        ? gasGet<{ customer: Customer; orders: Order[] }>('customer', { name }, { revalidate: 0 })
        : Promise.resolve({ customer: MOCK_CUSTOMERS.find(c => c.name === name) ?? MOCK_CUSTOMERS[0], orders: MOCK_ORDERS.filter(o => o.customer === name) }),
  },

  stock: {
    /**
     * GET ?route=stock
     * Full STOCK CONTROL list with computed values.
     * Cached 120s — stock changes only on delivery/return events.
     */
    list: (): Promise<StockResponse> =>
      IS_LIVE
        ? gasGet<StockResponse>('stock', {}, { revalidate: 120 })
        : Promise.resolve(mockStock()),
  },

  finance: {
    /**
     * GET ?route=finance
     * Expense ledger totals, cash balance, category breakdown.
     */
    get: (): Promise<FinanceResponse> =>
      IS_LIVE
        ? gasGet<FinanceResponse>('finance', {}, { revalidate: 60 })
        : Promise.resolve({ total_expenses: 116750, cash_balance: 2800, by_category: { 'Product Purchase': 59700, 'Advertising': 25000, 'Staff & HR': 15000, 'Courier & Delivery': 7300, 'Other': 9750 }, by_type: {}, recent_expenses: [] }),
  },

  courier: {
    list: (): Promise<{ shipments: unknown[] }> =>
      IS_LIVE
        ? gasGet<{ shipments: unknown[] }>('courier', {}, { revalidate: 30 })
        : Promise.resolve({ shipments: [] }),
  },

  log: {
    /**
     * GET ?route=log&limit=50
     * Last N events from 🤖 AUTOMATION LOG.
     * Revalidated every 30s; hook also polls every 30s.
     */
    recent: (limit = 50): Promise<LogResponse> =>
      IS_LIVE
        ? gasGet<LogResponse>('log', { limit: String(limit) }, { revalidate: 30 })
        : Promise.resolve({ events: [] }),
  },

  sla: {
    /**
     * GET ?route=sla_alerts
     * Orders whose SLA_STATUS column contains 'BREACH'.
     */
    alerts: (): Promise<SlaResponse> =>
      IS_LIVE
        ? gasGet<SlaResponse>('sla_alerts', {}, { revalidate: 60 })
        : Promise.resolve({
    breaches: MOCK_DASHBOARD.sla_breaches.map((b: any) => ({
      ...b,
      courier: '',
      tracking_id: ''
    })),
    count: MOCK_DASHBOARD.sla_breaches.length
  }),
  },

  invoice: {
    nextNumber: (): Promise<InvoiceNumResponse> =>
      IS_LIVE
        ? gasGet<InvoiceNumResponse>('next_invoice_num', {}, { revalidate: 0 })
        : Promise.resolve({ next: 'AL-INV-2026-0003' }),
  },

  // ── WRITE ─────────────────────────────────────────────────────────────────

  mutations: {
    /**
     * POST create_order
     * Appends a new row to ORDERS, writes SELL_PRICE + PROFIT formulas,
     * fires Phase 5 CRM hook. Returns the generated AL-XXXX order ID.
     *
     * Required: customer, phone, product, category, qty, unit_price, payment, source
     * Optional: address, size, discount, adv_cost, cogs, courier, notes, handled_by, sku
     */
    createOrder: (order: {
      customer: string
      phone: string
      address?: string
      product: string
      category: string
      qty: number
      unit_price: number
      payment: string
      source: string
      size?: string
      discount?: number
      add_discount?: number
      adv_cost?: number
      adv_platform?: string
      shipping_fee?: number
      cogs?: number
      courier_charge?: number
      other_costs?: number
      courier?: string
      notes?: string
      handled_by?: string
      sku?: string
    }): Promise<CreateOrderResponse> =>
      IS_LIVE
        ? gasPost<CreateOrderResponse>('create_order', order)
        : Promise.resolve({ ok: true, order_id: `AL-${String(Date.now()).slice(-4)}`, row: 99 }),

    /**
     * POST update_status
     * Changes the STATUS column and fires all Phase 2 automation hooks:
     *   Delivered → deduct stock, timestamp, sync courier, log financial event
     *   Returned  → restore stock, create RETURNS row, flag CRM risk
     *   Shipped   → write ship timestamp, set tracking status In Transit
     */
    updateStatus: (id: string, status: OrderStatus): Promise<StatusResponse> =>
      IS_LIVE
        ? gasPost<StatusResponse>('update_status', { id, status })
        : Promise.resolve({ ok: true, order_id: id, old_status: 'Pending', new_status: status }),

    /**
     * POST update_tracking
     * Writes tracking ID + optional courier name.
     * If order is still in Pending/Confirmed/Packed → auto-advances to Shipped.
     * Returns auto_shipped: true when status was advanced.
     */
    updateTracking: (id: string, tracking_id: string, courier?: string, tracking_status?: string): Promise<TrackingResponse> =>
      IS_LIVE
        ? gasPost<TrackingResponse>('update_tracking', { id, tracking_id, courier, tracking_status })
        : Promise.resolve({ ok: true, auto_shipped: true, tracking_id }),

    /**
     * POST update_order_field
     * Safe single-field write — refuses formula columns (ORDER_ID, SELL_PRICE, PROFIT, CUST_ORDER_NUM).
     * Use this for notes, handled_by, address corrections etc.
     */
    updateField: (id: string, field: string, value: string | number): Promise<MutationResponse> =>
      IS_LIVE
        ? gasPost<MutationResponse>('update_order_field', { id, field, value })
        : Promise.resolve({ ok: true }),

    /**
     * POST generate_invoice
     * Delegates to Phase 4 generateInvoice():
     *   • Builds branded HTML invoice
     *   • Converts to PDF via Drive API
     *   • Saves to 06_Invoices/Year/Month/ and to Orders/Year/Month/OrderID/Invoice/
     *   • Writes invoice number back to column AR of ORDERS sheet
     *   • Duplicate-safe: skips if invoice already exists (column AR non-empty)
     */
    generateInvoice: (id: string): Promise<InvoiceResponse> =>
      IS_LIVE
        ? gasPost<InvoiceResponse>('generate_invoice', { id })
        : Promise.resolve({ ok: true, invoice_number: 'AL-INV-2026-0003', file_url: '#', file_name: 'AL-INV-2026-0003.pdf' }),

    /**
     * POST create_order_folder
     * Delegates to Phase 3 Drive:
     *   Creates Orders/Year/Month/OrderID/ with 5 subfolders
     *   (Payment_Proof, Courier_Slip, Invoice, Product_Photos, Correspondence)
     */
    createOrderFolder: (id: string): Promise<FolderResponse> =>
      IS_LIVE
        ? gasPost<FolderResponse>('create_order_folder', { id })
        : Promise.resolve({ ok: true, folder_url: '#' }),

    /**
     * POST add_expense
     * Appends to 💸 EXPENSE LEDGER with auto EXP-ID formula.
     */
    addExpense: (expense: {
      category: string
      amount: number
      sub_cat?: string
      exp_type?: string
      description?: string
      vendor?: string
      payment?: string
      notes?: string
      linked_order?: string
    }): Promise<ExpenseResponse> =>
      IS_LIVE
        ? gasPost<ExpenseResponse>('add_expense', expense)
        : Promise.resolve({ ok: true, exp_id: `EXP-${Date.now()}`, row: 99 }),

    /**
     * POST create_customer
     * Delegates to Phase 5 ensureCustomerProfile_() — dedup-safe by name+phone.
     */
    createCustomer: (name: string, phone: string, address?: string, district?: string, source?: string): Promise<CustomerCreateResponse> =>
      IS_LIVE
        ? gasPost<CustomerCreateResponse>('create_customer', { name, phone, address, district, source })
        : Promise.resolve({ ok: true, profile_row: 99 }),

    /**
     * POST backfill_sla
     * Triggers runManualSLARefresh on all order rows.
     * Use after bulk imports or manual status changes.
     */
    backfillSla: (): Promise<MutationResponse> =>
      IS_LIVE
        ? gasPost<MutationResponse>('backfill_sla', {})
        : Promise.resolve({ ok: true }),
  },
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  MOCK DATA HELPERS — used when IS_LIVE is false                        ║
// ╚══════════════════════════════════════════════════════════════════════════╝

function mockOrders(p?: { status?: string; source?: string; payment?: string; search?: string }): OrdersResponse {
  let orders = [...MOCK_ORDERS]
  if (p?.status && p.status !== 'All') orders = orders.filter(o => o.status === p.status)
  if (p?.source)  orders = orders.filter(o => o.source === p.source)
  if (p?.payment) orders = orders.filter(o => o.payment === p.payment)
  if (p?.search) {
    const q = p.search.toLowerCase()
    orders = orders.filter(o => [o.id, o.customer, o.product, o.phone].some(v => v.toLowerCase().includes(q)))
  }
  const by_status: Record<string, number> = {}
  orders.forEach(o => { by_status[o.status] = (by_status[o.status] ?? 0) + 1 })
  return {
    orders,
    summary: {
      total: orders.length,
      total_revenue: orders.reduce((a, o) => a + o.sell_price, 0),
      total_profit:  orders.reduce((a, o) => a + o.profit, 0),
      by_status,
    },
  }
}

function mockCustomers(p?: { segment?: string; risk_level?: string; search?: string }): CustomersResponse {
  let cs = [...MOCK_CUSTOMERS]
  if (p?.segment)    cs = cs.filter(c => c.segment === p.segment)
  if (p?.risk_level) cs = cs.filter(c => c.risk_level === p.risk_level)
  if (p?.search) {
    const q = p.search.toLowerCase()
    cs = cs.filter(c => [c.name, c.phone, c.district].some(v => v.toLowerCase().includes(q)))
  }
  const by_segment: Record<string, number> = {}
  const by_risk: Record<string, number> = {}
  cs.forEach(c => {
    by_segment[c.segment]    = (by_segment[c.segment]    ?? 0) + 1
    by_risk[c.risk_level]    = (by_risk[c.risk_level]    ?? 0) + 1
  })
  return {
    customers: cs,
    summary: {
      total: cs.length,
      by_segment, by_risk,
      total_revenue: cs.reduce((a, c) => a + c.total_spent, 0),
      avg_clv: cs.length > 0 ? Math.round(cs.reduce((a, c) => a + c.clv_score, 0) / cs.length) : 0,
    },
  }
}

function mockStock(): StockResponse {
  return {
    items: MOCK_STOCK,
    summary: {
      total_skus:     MOCK_STOCK.length,
      total_value:    MOCK_STOCK.reduce((a, i) => a + i.stock_value, 0),
      total_sell_val: MOCK_STOCK.reduce((a, i) => a + i.sell_value, 0),
      low_stock:      MOCK_STOCK.filter(i => i.available <= i.reorder_level && i.available > 0).length,
      out_of_stock:   MOCK_STOCK.filter(i => i.available <= 0).length,
    },
  }
}
