/**
 * Domain-specific hooks — one per data resource.
 * All hooks fetch exclusively from the live Google Sheets API.
 */
'use client'
import { useCallback } from 'react'
import { api } from '@/lib/api'
import { useQuery, useMutation } from './useQuery'
import type { OrderStatus } from '@/types'

// ── READ HOOKS ────────────────────────────────────────────────────────────

/**
 * Live dashboard KPIs. Re-fetches silently every 60s.
 * On the initial load shows a loading skeleton.
 */
export function useDashboard() {
  return useQuery(
    () => api.dashboard.get(),
    [],
    { pollMs: 60_000 }
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
  return useQuery(
    () => api.orders.list(filters),
    [filters?.status, filters?.source, filters?.payment, filters?.search],
    { pollMs: 30_000 }
  )
}

/**
 * Single order detail.
 * No polling — only fetches when id changes.
 * Skipped entirely when id is null.
 */
export function useOrder(id: string | null) {
  return useQuery(
    () => id ? api.orders.get(id) : Promise.resolve(null),
    [id],
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
  return useQuery(
    () => api.customers.list(filters),
    [filters?.segment, filters?.risk_level, filters?.search],
    { pollMs: 90_000 }
  )
}

/**
 * Single customer + their orders.
 */
export function useCustomer(name: string | null) {
  return useQuery(
    () => name ? api.customers.get(name) : Promise.resolve(null),
    [name],
    { enabled: name !== null }
  )
}

/**
 * Stock control list. Polls every 2 minutes.
 * Stock only changes on Delivered/Returned events.
 */
export function useStock() {
  return useQuery(
    () => api.stock.list(),
    [],
    { pollMs: 120_000 }
  )
}

/**
 * Finance data — expense ledger totals, cash balance.
 */
export function useFinance() {
  return useQuery(
    () => api.finance.get(),
    [],
    { pollMs: 120_000 }
  )
}

/**
 * Automation log, last N events. Polls every 30s.
 */
export function useAutomationLog(limit = 50) {
  return useQuery(
    () => api.log.recent(limit),
    [limit],
    { pollMs: 30_000 }
  )
}

/**
 * SLA breach alerts. Polls every 2 minutes.
 */
export function useSlaAlerts() {
  return useQuery(
    () => api.sla.alerts(),
    [],
    { pollMs: 120_000 }
  )
}

/**
 * Next invoice number preview (peek without incrementing counter).
 */
export function useNextInvoiceNumber() {
  return useQuery(() => api.invoice.nextNumber())
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
    (id: string, status: OrderStatus) => api.mutations.updateStatus(id, status)
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
