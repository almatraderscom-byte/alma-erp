import type { AttendanceWaiverRequestType } from '@prisma/client'
import type { TelegramInlineButton } from '@/lib/trading-telegram-bot'
import { escapeHtml } from '@/lib/telegram-notification/formatters'

const REQUEST_TYPE_LABEL: Record<AttendanceWaiverRequestType, string> = {
  FULL_WAIVE: 'Full waive',
  PARTIAL_REDUCE: 'Partial reduction',
  RECONSIDERATION: 'Reconsideration',
}

export function formatPenaltyAppealTelegramMessage(input: {
  employeeName: string
  employeeId: string
  penaltyAmount: number
  requestedReduction: number
  requestType: AttendanceWaiverRequestType
  reason: string
}) {
  return [
    '⚠️ <b>Penalty Review Request</b>',
    '',
    `<b>Employee:</b> ${escapeHtml(input.employeeName)} (${escapeHtml(input.employeeId)})`,
    `<b>Penalty:</b> ৳ ${input.penaltyAmount.toLocaleString('en-BD')}`,
    `<b>Request:</b> ${escapeHtml(REQUEST_TYPE_LABEL[input.requestType] || input.requestType)}`,
    `<b>Asked reduction:</b> ৳ ${input.requestedReduction.toLocaleString('en-BD')}`,
    '',
    `<b>Reason:</b>`,
    escapeHtml(input.reason.slice(0, 400)),
  ].join('\n')
}

export function penaltyAppealTelegramKeyboard(waiverId: string, erpUrl: string) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve full', callback_data: `penalty:approve:${waiverId}` },
        { text: '✂️ Partial', callback_data: `penalty:partial:${waiverId}` },
        { text: '❌ Reject', callback_data: `penalty:reject:${waiverId}` },
      ],
      [{ text: 'Open ERP', url: erpUrl }],
    ] as TelegramInlineButton[][],
  }
}
