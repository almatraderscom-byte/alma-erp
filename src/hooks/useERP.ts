/**
 * Domain-specific hooks — one per data resource.
 * All hooks fetch exclusively from the live Google Sheets API.
 */
'use client'
import { useCallback } from 'react'
import { api } from '@/lib/api'
import { useQuery, useMutation } from './useQuery'
import type { OrderStatus } from '@/types'
import type { CreateProductInput, SupplierImportCommitResponse } from '@/lib/api'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useBusiness } from '@/contexts/BusinessContext'

// ── READ HOOKS ────────────────────────────────────────────────────────────

/**
 * Live dashboard KPIs. Re-fetches silently every 60s.
 * On the initial load shows a loading skeleton.
 */
export function useDashboard() {
  const { range } = useDateRange()
  const { businessId } = useBusiness()
  return useQuery(
    () => api.dashboard.get({ startDate: range.start, endDate: range.end }),
    [businessId, range.start, range.end],
    { pollMs: 60_000, cacheKey: `dashboard:${businessId}:${range.start}:${range.end}`, cacheMs: 20_000 },
  )
}

/**
 * Orders list with optional filters.
 * Re-runs whenever any filter value changes (deps array).
 * Polls every 30s for live order status updates.
 */
export function useOrders(filters?: {
  status?: string
  source?: string
  payment?: string
  search?: string
}) {
  const { businessId } = useBusiness()
  return useQuery(
    () => api.orders.list(filters),
    [businessId, filters?.status, filters?.source, filters?.payment, filters?.search],
    { pollMs: 30_000, cacheKey: `orders-hook:${businessId}:${filters?.status || ''}:${filters?.source || ''}:${filters?.payment || ''}:${filters?.search || ''}`, cacheMs: 15_000 }
  )
}

/**
 * Single order detail.
 * No polling — only fetches when id changes.
 * Skipped entirely when id is null.
 */
export function useOrder(id: string | null) {
  const { businessId } = useBusiness()
  return useQuery(
    () => id ? api.orders.get(id) : Promise.resolve(null),
    [businessId, id],
    { enabled: id !== null }
  )
}

/**
 * Customer list. Polls every 90s.
 */
export function useCustomers(filters?: {
  segment?: string
  risk_level?: string
  search?: string
}) {
  const { businessId } = useBusiness()
  return useQuery(
    () => api.customers.list(filters),
    [businessId, filters?.segment, filters?.risk_level, filters?.search],
    { pollMs: 90_000, cacheKey: `customers:${businessId}:${filters?.segment || ''}:${filters?.risk_level || ''}:${filters?.search || ''}`, cacheMs: 30_000 }
  )
}

/**
 * Single customer + their orders.
 */
export function useCustomer(name: string | null) {
  const { businessId } = useBusiness()
  return useQuery(
    () => name ? api.customers.get(name) : Promise.resolve(null),
    [businessId, name],
    { enabled: name !== null }
  )
}

/**
 * Stock control list. Polls every 2 minutes.
 * Stock only changes on Delivered/Returned events.
 */
export function useStock() {
  const { businessId } = useBusiness()
  return useQuery(
    () => api.stock.list(),
    [businessId],
    { pollMs: 120_000, cacheKey: `stock:${businessId}`, cacheMs: 30_000 }
  )
}

/**
 * PRODUCT MASTER catalog (GET /api/products → GAS `products`).
 */
export function useProducts() {
  const { businessId } = useBusiness()
  return useQuery(() => api.products.list(), [businessId], { pollMs: 120_000, cacheKey: `products:${businessId}`, cacheMs: 30_000 })
}

/**
 * Create PRODUCT MASTER row (+ STOCK row by default). Refetch catalog/stock after success.
 */
export function useCreateProduct() {
  const createProduct = useCallback((payload: CreateProductInput) => api.mutations.createProduct(payload), [])
  return useMutation(createProduct)
}

/**
 * Bulk append supplier-scraped rows to PRODUCT MASTER (chunked, duplicate-safe).
 */
export function useSupplierImportCommit() {
  const commit = useCallback(
    (payload: {
      items: Record<string, unknown>[]
      skip_duplicate_names?: boolean
    }): Promise<SupplierImportCommitResponse> => api.supplierImport.commit(payload),
    [],
  )
  return useMutation(commit)
}

/**
 * Finance data — expense ledger totals, cash balance.
 */
export function useFinance() {
  const { range } = useDateRange()
  const { businessId } = useBusiness()
  return useQuery(
    () => api.finance.get({ startDate: range.start, endDate: range.end }),
    [businessId, range.start, range.end],
    { pollMs: 120_000, cacheKey: `finance:${businessId}:${range.start}:${range.end}`, cacheMs: 30_000 },
  )
}

/** Merged KPIs incl. ledger expenses — respects global date range. */
export function useAnalyticsMerged() {
  const { range } = useDateRange()
  const { businessId } = useBusiness()
  return useQuery(
    () => api.analytics.get({ startDate: range.start, endDate: range.end }),
    [businessId, range.start, range.end],
    { pollMs: 90_000, cacheKey: `analytics:${businessId}:${range.start}:${range.end}`, cacheMs: 30_000 },
  )
}

/**
 * Automation log, last N events. Polls every 30s.
 */
export function useAutomationLog(limit = 50) {
  const { businessId } = useBusiness()
  return useQuery(
    () => api.log.recent(limit),
    [businessId, limit],
    { pollMs: 30_000 }
  )
}

/**
 * SLA breach alerts. Polls every 2 minutes.
 */
export function useSlaAlerts() {
  const { businessId } = useBusiness()
  return useQuery(
    () => api.sla.alerts(),
    [businessId],
    { pollMs: 120_000 }
  )
}

/**
 * Next invoice number preview (peek without incrementing counter).
 */
export function useNextInvoiceNumber() {
  const { businessId } = useBusiness()
  return useQuery(() => api.invoice.nextNumber(), [businessId])
}

// ── WRITE HOOKS ───────────────────────────────────────────────────────────

/**
 * Change order status.
 * Fires Phase 2 automation: stock deduct/restore, timestamps, courier sync, CRM.
 *
 * @example
 * const { mutate, loading } = useUpdateStatus()
 * await mutate('AL-0007', 'Delivered')
 * // → stock deducted, delivery date written, CRM updated
 */
export function useUpdateStatus() {
  return useMutation(
    (id: string, status: OrderStatus, reason?: string) => api.mutations.updateStatus(id, status, reason)
  )
}

/**
 * Write tracking ID. Auto-ships if order is pre-Shipped.
 *
 * @example
 * const { mutate } = useUpdateTracking()
 * const result = await mutate('AL-0007', 'RDX-12345', 'Redx')
 * if (result?.auto_shipped) toast.success('Auto-advanced to Shipped')
 */
export function useUpdateTracking() {
  return useMutation(
    (id: string, tracking_id: string, courier?: string) =>
      api.mutations.updateTracking(id, tracking_id, courier)
  )
}

/**
 * Create a new order row in Google Sheets.
 * Returns the generated AL-XXXX order ID on success.
 */
export function useCreateOrder() {
  return useMutation(api.mutations.createOrder)
}

/**
 * Generate a branded PDF invoice via Phase 4.
 * Saves to Google Drive, writes invoice number to column AR.
 * Duplicate-safe: re-calling for the same order returns the existing invoice.
 */
export function useGenerateInvoice() {
  return useMutation((id: string) => api.mutations.generateInvoice(id))
}

/**
 * Write any non-formula field on an order row.
 * Refuses formula columns (ORDER_ID, SELL_PRICE, PROFIT, CUST_ORDER_NUM).
 */
export function useUpdateField() {
  return useMutation(
    (id: string, field: string, value: string | number) =>
      api.mutations.updateField(id, field, value)
  )
}

/**
 * Append to the Expense Ledger.
 */
export function useAddExpense() {
  return useMutation(api.mutations.addExpense)
}

/**
 * Create a Drive folder structure for an order.
 * Safe to call multiple times — Phase 3 checks for existing folders first.
 */
export function useCreateOrderFolder() {
  return useMutation((id: string) => api.mutations.createOrderFolder(id))
}

/**
 * Ensure a customer profile exists in the CUSTOMERS sheet.
 * Dedup-safe by name + phone.
 */
export function useCreateCustomer() {
  return useMutation(
    (name: string, phone: string, address?: string, district?: string, source?: string) =>
      api.mutations.createCustomer(name, phone, address, district, source)
  )
}
