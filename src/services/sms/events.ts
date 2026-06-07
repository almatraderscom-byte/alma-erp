import { flushQueuedSms, queueSmsAndFlush } from '@/lib/sms/queue'
import { orderConfirmationSms, salaryReceivedSms } from '@/lib/sms/templates'

const LIFESTYLE_BUSINESS_ID = 'ALMA_LIFESTYLE'

export async function enqueueOrderConfirmationSms(input: {
  businessId?: string | null
  phone?: string | null
  invoice?: string | null
  orderId?: string | null
}) {
  const businessId = String(input.businessId || LIFESTYLE_BUSINESS_ID)
  if (businessId !== LIFESTYLE_BUSINESS_ID) return { ok: false, skipped: true, reason: 'WRONG_BUSINESS' }
  if (!input.phone?.trim()) return { ok: false, skipped: true, reason: 'MISSING_PHONE' }
  return flushQueuedSms({
    businessId: LIFESTYLE_BUSINESS_ID,
    phone: input.phone,
    type: 'ORDER_CONFIRMATION',
    message: orderConfirmationSms(input.invoice || input.orderId || ''),
    metadata: { orderId: input.orderId, invoice: input.invoice },
    cooldownMinutes: 120,
  })
}

/** Fire-and-forget variant for callers that cannot await. */
export function enqueueOrderConfirmationSmsAsync(input: Parameters<typeof enqueueOrderConfirmationSms>[0]) {
  void enqueueOrderConfirmationSms(input).catch(() => null)
}

export function enqueueInvoiceReadySms(_input: {
  businessId?: string | null
  phone?: string | null
  invoice?: string | null
  orderId?: string | null
}) {
  /* disabled — order confirmation only */
}

export function enqueueCourierUpdateSms(_input: {
  businessId?: string | null
  phone?: string | null
  tracking?: string | null
  orderId?: string | null
}) {
  /* disabled */
}

export async function enqueueOwnerAlertSms(_input: {
  businessId?: string | null
  type: 'PAYROLL_ADVANCE_ALERT' | 'LOW_STOCK_ALERT' | 'TRADING_DAILY_SUMMARY'
  message: string
  metadata?: Record<string, unknown>
  cooldownMinutes?: number
}) {
  /* disabled */
}

export function enqueuePayrollAdvanceAlertSms(_input: { businessId?: string | null; requestId?: string | null }) {
  /* disabled */
}

export function enqueueSalaryReceivedSms(input: {
  businessId?: string | null
  phone?: string | null
  employeeId?: string | null
  amount: number
  periodYm?: string | null
  entryId?: string | null
}) {
  if (!input.phone?.trim()) return
  queueSmsAndFlush({
    businessId: input.businessId || LIFESTYLE_BUSINESS_ID,
    phone: input.phone,
    type: 'SALARY_RECEIVED',
    message: salaryReceivedSms({ amount: input.amount, periodYm: input.periodYm }),
    metadata: { employeeId: input.employeeId, periodYm: input.periodYm, entryId: input.entryId },
    cooldownMinutes: 20 * 60,
  })
}

export function enqueueLowStockAlertSms(_input: { businessId?: string | null; product?: string | null }) {
  /* disabled */
}

export async function enqueueTradingDailySummarySms(_input: { profit: number; loss: number; net: number }) {
  /* disabled */
}
