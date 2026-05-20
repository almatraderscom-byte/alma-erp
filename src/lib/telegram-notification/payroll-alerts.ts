import { escapeHtml, erpBaseUrl } from '@/lib/telegram-notification/formatters'
import { withEmployeeAvatarMetadata } from '@/lib/telegram-notification/enqueue-metadata'
import { scheduleTelegramNotification } from '@/lib/telegram-notification/queue'

export function queuePayrollWalletRequestAlert(input: {
  businessId: string
  userId: string
  employeeId: string
  employeeName?: string | null
  type: 'ADVANCE' | 'WITHDRAWAL'
  amount: number
  reason: string
  requestId: string
}) {
  const label = input.type === 'WITHDRAWAL' ? 'Wallet withdrawal' : 'Salary advance'
  const link = `${erpBaseUrl()}/approvals`
  const message = [
    `💳 <b>${label} Request</b>`,
    '',
    `<b>Employee:</b> ${escapeHtml(input.employeeName || input.employeeId)}`,
    `<b>HR ID:</b> <code>${escapeHtml(input.employeeId)}</code>`,
    `<b>Amount:</b> ৳ ${input.amount.toLocaleString('en-BD')}`,
    `<b>Reason:</b> ${escapeHtml(input.reason.slice(0, 240))}`,
    '',
    `<a href="${link}">Review in Approvals →</a>`,
  ].join('\n')

  scheduleTelegramNotification({
    businessId: input.businessId,
    eventType: 'PAYROLL_WALLET_REQUEST',
    message,
    dedupeKey: `wallet:request:${input.requestId}`,
    metadata: withEmployeeAvatarMetadata(
      { requestId: input.requestId, employeeId: input.employeeId, type: input.type },
      input.userId,
      input.employeeName || input.employeeId,
    ),
  })
}
