import { prisma } from '@/lib/prisma'
import { answerTelegramCallbackQuery } from '@/lib/trading-telegram-bot'
import {
  applyVolumeTargetPenalty,
  ignoreVolumeTargetFailure,
  waiveVolumeTargetPenalty,
} from '@/lib/trading-volume-target'
import { isTradingSuperAdmin } from '@/lib/trading-volume-target-access'

async function resolveTelegramErpUser(telegramUserId: string) {
  const link = await prisma.tradingTelegramUser.findFirst({
    where: { telegramUserId, approved: true, userId: { not: null } },
    select: { userId: true },
  })
  if (!link?.userId) return null
  return prisma.user.findFirst({
    where: { id: link.userId, active: true },
    select: { id: true, role: true },
  })
}

export async function handleVolumeTargetTelegramCallback(
  data: string,
  _chatId: string,
  callbackQueryId: string,
  telegramUserId: string,
): Promise<boolean> {
  const match = /^target:(apply|partial|ignore):(.+)$/.exec(data)
  if (!match) return false

  const [, action, targetId] = match

  const erpUser = await resolveTelegramErpUser(telegramUserId)
  if (!erpUser || !isTradingSuperAdmin(erpUser.role)) {
    await answerTelegramCallbackQuery(callbackQueryId, 'Permission denied — Super Admin only')
    return true
  }

  const target = await prisma.tradingDailyVolumeTarget.findUnique({
    where: { id: targetId },
    include: { penalties: { where: { status: { in: ['APPLIED', 'PARTIALLY_WAIVED'] } } } },
  })

  if (!target) {
    await answerTelegramCallbackQuery(callbackQueryId, 'Target not found')
    return true
  }

  if (action === 'ignore') {
    const result = await ignoreVolumeTargetFailure(targetId, erpUser.id, 'Ignored via Telegram')
    if ('error' in result) {
      await answerTelegramCallbackQuery(callbackQueryId, (result.error || 'Failed').slice(0, 180))
      return true
    }
    await answerTelegramCallbackQuery(callbackQueryId, 'Target failure ignored')
    return true
  }

  if (action === 'partial') {
    await answerTelegramCallbackQuery(callbackQueryId, 'Open ERP → Target Control for partial penalty / waiver')
    return true
  }

  if (action === 'apply') {
    if (target.penalties.length) {
      await answerTelegramCallbackQuery(callbackQueryId, 'Penalty already applied')
      return true
    }
    const amount = target.penaltyAmountBdt ? Number(target.penaltyAmountBdt) : 0
    const settings = await prisma.tradingVolumeTargetSettings.findUnique({ where: { businessId: target.businessId } })
    const defaultAmt = settings ? Number(settings.defaultPenaltyBdt) : 500
    const applied = amount > 0 ? amount : defaultAmt
    const result = await applyVolumeTargetPenalty(targetId, erpUser.id, applied, 'Applied via Telegram')
    if ('error' in result) {
      await answerTelegramCallbackQuery(callbackQueryId, (result.error || 'Failed').slice(0, 180))
      return true
    }
    await answerTelegramCallbackQuery(callbackQueryId, `Penalty applied · ৳${applied}`)
    return true
  }

  return false
}
