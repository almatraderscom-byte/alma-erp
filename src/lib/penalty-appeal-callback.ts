import { prisma } from '@/lib/prisma'
import { answerTelegramCallbackQuery } from '@/lib/trading-telegram-bot'
import { resolveOwnerChatIds } from '@/lib/telegram-notification/settings'
import { resolveTelegramApprovalActor } from '@/lib/telegram-approval-actor'
import { reviewPenaltyAppeal } from '@/lib/penalty-appeal'

export async function handlePenaltyAppealTelegramCallback(
  data: string,
  chatId: string,
  callbackQueryId: string,
  telegramUserId: string,
): Promise<boolean> {
  const match = /^penalty:(approve|reject|partial):(.+)$/.exec(data)
  if (!match) return false

  const [, action, waiverId] = match
  const waiver = await prisma.attendanceWaiverRequest.findUnique({
    where: { id: waiverId },
    select: {
      id: true,
      businessId: true,
      status: true,
      originalPenaltyAmount: true,
      requestedReductionAmount: true,
    },
  })

  if (!waiver) {
    await answerTelegramCallbackQuery(callbackQueryId, 'Request not found')
    return true
  }

  const ownerChats = await resolveOwnerChatIds(waiver.businessId)
  if (!ownerChats.includes(String(chatId))) {
    await answerTelegramCallbackQuery(callbackQueryId, 'Not authorized for this action')
    return true
  }

  if (waiver.status !== 'PENDING') {
    await answerTelegramCallbackQuery(callbackQueryId, 'Already reviewed')
    return true
  }

  if (action === 'partial') {
    await answerTelegramCallbackQuery(callbackQueryId, 'Open ERP → Attendance to enter partial amount')
    return true
  }

  const actor = await resolveTelegramApprovalActor(telegramUserId, waiver.businessId)
  if (!actor) {
    await answerTelegramCallbackQuery(callbackQueryId, 'No ERP reviewer linked to this Telegram account')
    return true
  }

  const original = Number(waiver.originalPenaltyAmount || 0)
  const requested = Number(waiver.requestedReductionAmount ?? original)

  const result = await reviewPenaltyAppeal({
    waiverId: waiver.id,
    businessId: waiver.businessId,
    actorUserId: actor.userId,
    action: action === 'reject' ? 'REJECT' : 'APPROVE',
    approvedReductionAmount: action === 'approve' ? requested : undefined,
    adminNote: action === 'approve' ? 'Approved via Telegram' : 'Rejected via Telegram',
    source: 'telegram',
  })

  if ('error' in result) {
    await answerTelegramCallbackQuery(callbackQueryId, (result.error || 'Review failed').slice(0, 180))
    return true
  }

  if ('alreadyReviewed' in result && result.alreadyReviewed) {
    await answerTelegramCallbackQuery(callbackQueryId, 'Already reviewed')
    return true
  }

  await answerTelegramCallbackQuery(
    callbackQueryId,
    action === 'approve' ? `Approved · final ৳${result.waiver.finalAppliedPenalty}` : 'Rejected',
  )
  return true
}
