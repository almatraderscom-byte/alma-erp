import { prisma } from '@/lib/prisma'
import { flushQueuedSms, queueSmsAndFlush } from '@/lib/sms/queue'
import {
  courierUpdateSms,
  invoiceReadySms,
  lowStockAlertSms,
  orderConfirmationSms,
  payrollAdvanceAlertSms,
  salaryReceivedSms,
  tradingDailySummarySms,
} from '@/lib/sms/templates'

export async function enqueueOrderConfirmationSms(input: {
  businessId?: string | null
  phone?: string | null
  invoice?: string | null
  orderId?: string | null
}) {
  if (!input.phone?.trim()) return { ok: false, skipped: true, reason: 'MISSING_PHONE' }
  return flushQueuedSms({
    businessId: input.businessId || 'ALMA_LIFESTYLE',
    phone: input.phone,
    type: 'ORDER_CONFIRMATION',
    message: orderConfirmationSms(input.invoice || input.orderId || ''),
    metadata: { orderId: input.orderId, invoice: input.invoice },
    cooldownMinutes: 120,
  })
}

export function enqueueOrderConfirmationSmsAsync(input: Parameters<typeof enqueueOrderConfirmationSms>[0]) {
  void enqueueOrderConfirmationSms(input).catch(() => null)
}

export async function enqueueInvoiceReadySms(input: {
  businessId?: string | null
  phone?: string | null
  invoice?: string | null
  orderId?: string | null
}) {
  if (!input.phone?.trim()) return
  queueSmsAndFlush({
    businessId: input.businessId || 'ALMA_LIFESTYLE',
    phone: input.phone,
    type: 'INVOICE_READY',
    message: invoiceReadySms(input.invoice || input.orderId || ''),
    metadata: { orderId: input.orderId, invoice: input.invoice },
    cooldownMinutes: 120,
  })
}

export async function enqueueCourierUpdateSms(input: {
  businessId?: string | null
  phone?: string | null
  tracking?: string | null
  orderId?: string | null
}) {
  if (!input.phone?.trim()) return
  queueSmsAndFlush({
    businessId: input.businessId || 'ALMA_LIFESTYLE',
    phone: input.phone,
    type: 'COURIER_UPDATE',
    message: courierUpdateSms(input.tracking || input.orderId || ''),
    metadata: { orderId: input.orderId, tracking: input.tracking },
    cooldownMinutes: 120,
  })
}

export async function enqueueOwnerAlertSms(input: {
  businessId?: string | null
  type: 'PAYROLL_ADVANCE_ALERT' | 'LOW_STOCK_ALERT' | 'TRADING_DAILY_SUMMARY'
  message: string
  metadata?: Record<string, unknown>
  cooldownMinutes?: number
}) {
  const users = await prisma.user.findMany({
    where: {
      active: true,
      role: 'SUPER_ADMIN',
      phone: { not: null },
    },
    select: { phone: true },
  })
  for (const user of users) {
    if (!user.phone) continue
    queueSmsAndFlush({
      businessId: input.businessId || null,
      phone: user.phone,
      type: input.type,
      message: input.message,
      metadata: input.metadata,
      cooldownMinutes: input.cooldownMinutes ?? 60,
    })
  }
}

export async function enqueuePayrollAdvanceAlertSms(input: {
  businessId?: string | null
  requestId?: string | null
}) {
  await enqueueOwnerAlertSms({
    businessId: input.businessId,
    type: 'PAYROLL_ADVANCE_ALERT',
    message: payrollAdvanceAlertSms(),
    metadata: { requestId: input.requestId },
    cooldownMinutes: 60,
  })
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
    businessId: input.businessId || 'ALMA_LIFESTYLE',
    phone: input.phone,
    type: 'SALARY_RECEIVED',
    message: salaryReceivedSms({ amount: input.amount, periodYm: input.periodYm }),
    metadata: { employeeId: input.employeeId, periodYm: input.periodYm, entryId: input.entryId },
    cooldownMinutes: 20 * 60,
  })
}

export async function enqueueLowStockAlertSms(input: {
  businessId?: string | null
  product?: string | null
}) {
  await enqueueOwnerAlertSms({
    businessId: input.businessId || 'ALMA_LIFESTYLE',
    type: 'LOW_STOCK_ALERT',
    message: lowStockAlertSms(input.product || 'inventory'),
    metadata: { product: input.product },
    cooldownMinutes: 6 * 60,
  })
}

export async function enqueueTradingDailySummarySms(input: {
  profit: number
  loss: number
  net: number
}) {
  await enqueueOwnerAlertSms({
    businessId: 'ALMA_TRADING',
    type: 'TRADING_DAILY_SUMMARY',
    message: tradingDailySummarySms(input),
    metadata: input,
    cooldownMinutes: 20 * 60,
  })
}
