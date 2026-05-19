import type { TradingTradeType } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID } from '@/lib/trading'

export type PendingDuplicatePayload = {
  parsed: {
    tradeType: TradingTradeType
    usdtAmount: number
    bdtRate: number
    feeUsdt: number
    alias: string | null
  }
  accountId: string
  accountTitle: string
  alias: string | null
  fingerprint: string
  messageId: number
}

const TTL_MS = 15 * 60_000

export async function createPendingDuplicate(params: {
  telegramUserId: string
  telegramChatId: string
  rawMessage: string
  payload: PendingDuplicatePayload
}) {
  const expiresAt = new Date(Date.now() + TTL_MS)
  await prisma.tradingTelegramPendingDuplicate.deleteMany({
    where: {
      businessId: TRADING_BUSINESS_ID,
      telegramUserId: params.telegramUserId,
    },
  })
  return prisma.tradingTelegramPendingDuplicate.create({
    data: {
      businessId: TRADING_BUSINESS_ID,
      telegramUserId: params.telegramUserId,
      telegramChatId: params.telegramChatId,
      rawMessage: params.rawMessage,
      payload: params.payload,
      expiresAt,
    },
  })
}

export async function loadPendingDuplicate(id: string, telegramUserId: string) {
  const row = await prisma.tradingTelegramPendingDuplicate.findFirst({
    where: {
      id,
      businessId: TRADING_BUSINESS_ID,
      telegramUserId,
      expiresAt: { gt: new Date() },
    },
  })
  if (!row) return null
  return { row, payload: row.payload as PendingDuplicatePayload }
}

export async function clearPendingDuplicate(id: string) {
  await prisma.tradingTelegramPendingDuplicate.deleteMany({ where: { id } })
}

export async function purgeExpiredPendingDuplicates() {
  await prisma.tradingTelegramPendingDuplicate.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  })
}
