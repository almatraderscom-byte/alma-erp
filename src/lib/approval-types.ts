/** Central approval module + type constants. */

export const APPROVAL_MODULES = {
  PAYROLL: 'PAYROLL',
  ALMA_TRADING: 'ALMA_TRADING',
  INVENTORY: 'INVENTORY',
  ORDERS_CRM: 'ORDERS_CRM',
  FINANCE: 'FINANCE',
} as const

export const APPROVAL_TYPES = {
  EXPENSE_ADD: 'EXPENSE_ADD',
  PENALTY_APPEAL: 'PENALTY_APPEAL',
  WALLET_WITHDRAWAL: 'WALLET_WITHDRAWAL',
  WALLET_ADVANCE: 'WALLET_ADVANCE',
  SALARY_ADVANCE: 'SALARY_ADVANCE',
  TRADE_DELETE: 'TRADE_DELETE',
  ORDER_DELETE: 'ORDER_DELETE',
  MEAL_ALLOWANCE: 'MEAL_ALLOWANCE',
  DRIVING_MODE: 'DRIVING_MODE',
  SALARY_CORRECTION: 'SALARY_CORRECTION',
  NO_CHECKOUT_FINE: 'NO_CHECKOUT_FINE',
  ATTENDANCE_EXCEPTION: 'ATTENDANCE_EXCEPTION',
  ATTENDANCE_LEAVE: 'ATTENDANCE_LEAVE',
  // Office expense / petty-cash flow (owner-approved). EXPENSE_REIMBURSEMENT: a staff
  // member paid out of pocket and gets it back in their wallet on approval.
  // OFFICE_FUND_ADVANCE: an admin draws office cash (owner sends it manually).
  // OFFICE_FUND_RECONCILE: the admin accounts for an advance (spent + leftover).
  EXPENSE_REIMBURSEMENT: 'EXPENSE_REIMBURSEMENT',
  OFFICE_FUND_ADVANCE: 'OFFICE_FUND_ADVANCE',
  OFFICE_FUND_RECONCILE: 'OFFICE_FUND_RECONCILE',
} as const

export type ApprovalSource = 'erp' | 'telegram' | 'attendance' | 'api'

export type ApprovalAuditEntry = {
  action: string
  actorUserId: string | null
  reason?: string | null
  source?: ApprovalSource
  timestamp: string
  metadata?: Record<string, unknown>
}
