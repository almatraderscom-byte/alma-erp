import type { TradingTradeType } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID } from '@/lib/trading'
import { tradingBdDayBounds, tradingBdYmdFromInstant } from '@/lib/trading-compliance'

const ACTIVE_DRAFT_STATUSES = ['PENDING', 'APPROVED', 'POSTED'] as const

export function buildDraftFingerprint(input: {
  tradeType: TradingTradeType
  usdtAmount: number
  bdtRate: number
  feeUsdt: number
  tradingAccountId: string
}): string {
  return [
    input.tradingAccountId,
    input.tradeType,
    input.usdtAmount.toFixed(4),
    input.bdtRate.toFixed(4),
    input.feeUsdt.toFixed(4),
  ].join(':')
}

export async function nextTradeNumberForUser(telegramUserId: string): Promise<number> {
  const { start, end } = tradingBdDayBounds()
  const maxRow = await prisma.tradingTelegramDraft.findFirst({
    where: {
      businessId: TRADING_BUSINESS_ID,
      telegramUserId,
      createdAt: { gte: start, lt: end },
      status: { in: [...ACTIVE_DRAFT_STATUSES] },
    },
    orderBy: { tradeNumber: 'desc' },
    select: { tradeNumber: true },
  })
  return (maxRow?.tradeNumber ?? 0) + 1
}

export async function findUserDuplicateDraft(
  telegramUserId: string,
  fingerprint: string,
): Promise<{
  id: string
  tradeNumber: number | null
  createdAt: Date
  accountTitle: string | null
  accountAlias: string | null
} | null> {
  const { start, end } = tradingBdDayBounds()
  return prisma.tradingTelegramDraft.findFirst({
    where: {
      businessId: TRADING_BUSINESS_ID,
      telegramUserId,
      draftFingerprint: fingerprint,
      status: { in: ['PENDING', 'APPROVED', 'POSTED'] },
      createdAt: { gte: start, lt: end },
    },
    select: {
      id: true,
      tradeNumber: true,
      createdAt: true,
      accountTitle: true,
      accountAlias: true,
    },
    orderBy: { createdAt: 'desc' },
  })
}

export type UserTelegramDaySummary = {
  ymd: string
  tradeCount: number
  buyVolumeUsdt: number
  sellVolumeUsdt: number
  feesBdt: number
  pendingDrafts: number
  estimatedPlBdt: number
  defaultAccountTitle: string | null
  defaultAccountAlias: string | null
}

export async function buildUserTelegramDaySummary(telegramUserId: string): Promise<UserTelegramDaySummary> {
  const { start, end, ymd } = tradingBdDayBounds()

  const link = await prisma.tradingTelegramUser.findFirst({
    where: { businessId: TRADING_BUSINESS_ID, telegramUserId },
    select: { defaultAccountAlias: true, defaultTradingAccountId: true },
  })

  let defaultAccountTitle: string | null = null
  if (link?.defaultTradingAccountId) {
    const acc = await prisma.tradingAccount.findUnique({
      where: { id: link.defaultTradingAccountId },
      select: { accountTitle: true },
    })
    defaultAccountTitle = acc?.accountTitle ?? null
  }

  const drafts = await prisma.tradingTelegramDraft.findMany({
    where: {
      businessId: TRADING_BUSINESS_ID,
      telegramUserId,
      createdAt: { gte: start, lt: end },
      status: { in: [...ACTIVE_DRAFT_STATUSES, 'UNDONE'] },
    },
    select: {
      status: true,
      tradeType: true,
      usdtAmount: true,
      bdtRate: true,
      feeUsdt: true,
    },
  })

  let buyVolumeUsdt = 0
  let sellVolumeUsdt = 0
  let buyBdt = 0
  let sellBdt = 0
  let feeBdt = 0
  let tradeCount = 0
  let pendingDrafts = 0

  for (const d of drafts) {
    if (d.status === 'UNDONE') continue
    tradeCount += 1
    if (d.status === 'PENDING') pendingDrafts += 1
    const usdt = Number(d.usdtAmount ?? 0)
    const rate = Number(d.bdtRate ?? 0)
    const fee = Number(d.feeUsdt ?? 0)
    const gross = usdt * rate
    const feeLine = fee * rate
    feeBdt += feeLine
    if (d.tradeType === 'BUY') {
      buyVolumeUsdt += usdt
      buyBdt += gross
    } else if (d.tradeType === 'SELL') {
      sellVolumeUsdt += usdt
      sellBdt += gross
    }
  }

  const estimatedPlBdt = Math.round((sellBdt - buyBdt - feeBdt) * 100) / 100

  return {
    ymd,
    tradeCount,
    buyVolumeUsdt: Math.round(buyVolumeUsdt * 100) / 100,
    sellVolumeUsdt: Math.round(sellVolumeUsdt * 100) / 100,
    feesBdt: Math.round(feeBdt * 100) / 100,
    pendingDrafts,
    estimatedPlBdt,
    defaultAccountTitle,
    defaultAccountAlias: link?.defaultAccountAlias ?? null,
  }
}

export async function undoLastUserDraft(telegramUserId: string) {
  const last = await prisma.tradingTelegramDraft.findFirst({
    where: {
      businessId: TRADING_BUSINESS_ID,
      telegramUserId,
      status: 'PENDING',
    },
    orderBy: { createdAt: 'desc' },
  })
  if (!last) return null

  return prisma.tradingTelegramDraft.update({
    where: { id: last.id },
    data: { status: 'UNDONE', undoneAt: new Date() },
  })
}

export type DraftGroupKey = {
  userId: string | null
  userName: string
  profileImageUrl?: string | null
  telegramUsername: string | null
  telegramUserId: string
  tradingAccountId: string | null
  accountTitle: string | null
  accountAlias: string | null
}

export function groupDraftsByUserAndAccount<T extends {
  id: string
  userId: string | null
  user?: { id?: string; name: string; profileImageUrl?: string | null } | null
  telegramUserId: string
  telegramUsername: string | null
  tradingAccountId: string | null
  accountTitle: string | null
  accountAlias: string | null
  tradeNumber: number | null
  status: string
  tradeType: string | null
  usdtAmount: unknown
  bdtRate: unknown
  feeUsdt: unknown
  rawMessage: string
  createdAt: Date | string
}>(drafts: T[]) {
  const map = new Map<string, { key: DraftGroupKey; drafts: T[] }>()

  for (const d of drafts) {
    const gid = `${d.userId ?? 'none'}:${d.tradingAccountId ?? 'none'}:${d.telegramUserId}`
    if (!map.has(gid)) {
      map.set(gid, {
        key: {
          userId: d.userId,
          userName: d.user?.name || 'Unknown',
          profileImageUrl: d.user?.profileImageUrl ?? null,
          telegramUsername: d.telegramUsername,
          telegramUserId: d.telegramUserId,
          tradingAccountId: d.tradingAccountId,
          accountTitle: d.accountTitle,
          accountAlias: d.accountAlias,
        },
        drafts: [],
      })
    }
    map.get(gid)!.drafts.push(d)
  }

  return [...map.values()].sort((a, b) => a.key.userName.localeCompare(b.key.userName))
}

export type DraftDayGroupKey = {
  ymd: string
  tradingAccountId: string | null
  accountTitle: string | null
  accountAlias: string | null
}

function draftYmd(createdAt: Date | string): string {
  return tradingBdYmdFromInstant(createdAt)
}

export function groupDraftsByDayAndAccount<T extends {
  id: string
  tradingAccountId: string | null
  accountTitle: string | null
  accountAlias: string | null
  createdAt: Date | string
}>(drafts: T[]) {
  const map = new Map<string, { key: DraftDayGroupKey; drafts: T[] }>()

  for (const d of drafts) {
    const ymd = draftYmd(d.createdAt)
    const gid = `${ymd}:${d.tradingAccountId ?? 'none'}`
    if (!map.has(gid)) {
      map.set(gid, {
        key: {
          ymd,
          tradingAccountId: d.tradingAccountId,
          accountTitle: d.accountTitle,
          accountAlias: d.accountAlias,
        },
        drafts: [],
      })
    }
    map.get(gid)!.drafts.push(d)
  }

  return [...map.values()].sort((a, b) => b.key.ymd.localeCompare(a.key.ymd))
}
