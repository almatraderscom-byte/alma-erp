import type { NotificationType, UserRole } from '@prisma/client'

/**
 * Role matrix — the ONE place that says which roles hear about which business
 * event (2026-07-14 notification audit). Call sites pass these to
 * `notifyRoles()` instead of hand-rolling per-role `notifyRole` blocks, so
 * changing who gets what is a one-line edit here.
 *
 * STAFF on order events is deliberate: staff fulfil orders, and the audit
 * found they received nothing at all ("New order assigned" went only to
 * admins). VIEWER is read-only and never targeted.
 */
export const NOTIFY_ROLES = {
  /** A new order was created (in-app or website ingest) — fulfilment work. */
  orderCreated: ['SUPER_ADMIN', 'ADMIN', 'STAFF'] as UserRole[],
  /** An order changed status (the resolved handler is notified separately). */
  orderStatusChanged: ['SUPER_ADMIN', 'ADMIN'] as UserRole[],
  /** Inventory ran low / out of stock. */
  lowStock: ['SUPER_ADMIN', 'ADMIN'] as UserRole[],
  /** An expense hit the books. */
  expenseAdded: ['SUPER_ADMIN', 'ADMIN'] as UserRole[],
  /** An invoice was generated. */
  invoiceCreated: ['SUPER_ADMIN', 'ADMIN'] as UserRole[],
  /** Staff asked for a salary advance — approvers. */
  advanceRequested: ['SUPER_ADMIN', 'ADMIN', 'HR'] as UserRole[],
} satisfies Record<string, UserRole[]>

/**
 * Landing page per notification type when a call site passes no actionUrl.
 * Before this map a missing actionUrl resolved to the SITE ROOT, silently
 * dropping the tap on the dashboard.
 */
export const DEFAULT_ACTION_URL: Partial<Record<NotificationType, string>> = {
  SALARY_ADDED: '/portal/wallet',
  ACCRUAL_FAILED: '/payroll',
  WALLET_REQUEST_APPROVED: '/portal/wallet',
  WALLET_REQUEST_REJECTED: '/portal/wallet',
  INVOICE_CREATED: '/invoice',
  ORDER_ASSIGNED: '/orders',
  LOW_STOCK: '/inventory',
  PAYROLL_ALERT: '/payroll',
  EXPENSE_ADDED: '/finance',
}
