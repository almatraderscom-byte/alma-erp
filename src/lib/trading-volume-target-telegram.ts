import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID } from '@/lib/trading'
import { sendTelegramMessage } from '@/lib/trading-telegram-bot'
import { resolveOwnerChatIds } from '@/lib/telegram-notification/settings'
import { volumeTargetDto } from '@/lib/trading-volume-target'

export function volumeTargetPenaltyKeyboard(targetId: string) {
  return {
    inline_keyboard: [
      [
        { text: 'Apply Penalty', callback_data: `target:apply:${targetId}` },
        { text: 'Partial Penalty', callback_data: `target:partial:${targetId}` },
      ],
      [{ text: 'Ignore', callback_data: `target:ignore:${targetId}` }],
    ],
  }
}

export async function notifyMissedVolumeTarget(targetId: string) {
  const row = await prisma.tradingDailyVolumeTarget.findFirst({
    where: { id: targetId, businessId: TRADING_BUSINESS_ID },
    include: {
      tradingAccount: { include: { assignedUser: { select: { name: true, employeeIdGas: true } } } },
      penalties: { take: 1, orderBy: { createdAt: 'desc' } },
    },
  })
  if (!row || row.status !== 'MISSED') return

  const dto = volumeTargetDto(row)
  const chats = await resolveOwnerChatIds(TRADING_BUSINESS_ID)
  if (!chats.length) return

  const text = [
    '⚠️ Trading volume target missed',
    `Account: ${dto.accountTitle || '—'}`,
    `Staff: ${dto.assignedUserName || 'Unassigned'}`,
    `Date: ${dto.targetDate.slice(0, 10)}`,
    `Target: ${dto.targetUsdt} USDT · Actual: ${dto.actualUsdt} USDT`,
    `Shortfall: ${dto.shortfallUsdt} USDT`,
    dto.penaltyAmountBdt != null ? `Suggested penalty: ৳${dto.penaltyAmountBdt}` : '',
    '',
    'Super Admin only — use buttons below.',
  ]
    .filter(Boolean)
    .join('\n')

  const keyboard = volumeTargetPenaltyKeyboard(targetId)
  await Promise.all(
    chats.map(chatId => sendTelegramMessage(chatId, text, { replyMarkup: keyboard })),
  )
}
