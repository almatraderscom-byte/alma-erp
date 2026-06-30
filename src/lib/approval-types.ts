/** Central approval module + type constants. */

export const APPROVAL_MODULES = {
  PAYROLL: 'PAYROLL',
  ALMA_TRADING: 'ALMA_TRADING',
  INVENTORY: 'INVENTORY',
  ORDERS_CRM: 'ORDERS_CRM',
} as const

export const APPROVAL_TYPES = {
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
