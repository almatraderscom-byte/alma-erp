import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID } from '@/lib/trading'

export type TelegramDraftAuditEvent =
  | 'DRAFT_CREATED'
  | 'DRAFT_EDITED'
  | 'DRAFT_CONFIRMED'
  | 'DRAFT_REJECTED'
  | 'DRAFT_REOPENED'
  | 'DRAFT_DELETE_REQUESTED'

export async function logTelegramDraftAudit(input: {
  eventType: TelegramDraftAuditEvent
  draftId: string
  actorUserId: string
  telegramUserId?: string | null
  telegramChatId?: string | null
  detail?: string
}) {
  const detailParts = [`draftId=${input.draftId}`, `actorUserId=${input.actorUserId}`]
  if (input.detail) detailParts.push(input.detail)

  await prisma.tradingTelegramAuditLog.create({
    data: {
      businessId: TRADING_BUSINESS_ID,
      eventType: input.eventType,
      telegramUserId: input.telegramUserId ?? null,
      telegramChatId: input.telegramChatId ?? null,
      detail: detailParts.join('; '),
    },
  })
}
