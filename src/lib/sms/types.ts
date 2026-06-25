export type SmsType =
  | 'ORDER_CONFIRMATION'
  | 'INVOICE_READY'
  | 'COURIER_UPDATE'
  | 'TRADING_DAILY_SUMMARY'
  | 'SALARY_RECEIVED'
  | 'WALLET_WITHDRAWAL_APPROVED'
  | 'PAYROLL_ADVANCE_ALERT'
  | 'LOW_STOCK_ALERT'
  | 'TEST'

export type SmsStatus = 'QUEUED' | 'SENDING' | 'SENT' | 'DELIVERED' | 'FAILED' | 'PENDING'

export type QueueSmsInput = {
  businessId?: string | null
  phone: string
  message: string
  type: SmsType
  metadata?: Record<string, unknown>
  cooldownMinutes?: number
  contentId?: string
}

export type SmsProviderSendResult = {
  ok: boolean
  requestId?: string
  errorCode?: string
  errorMessage?: string
  raw?: unknown
}

export type SmsDeliveryReport = {
  ok: boolean
  status: 'Sent' | 'Failed' | 'Pending'
  errorCode?: string
  errorMessage?: string
  raw?: unknown
}
