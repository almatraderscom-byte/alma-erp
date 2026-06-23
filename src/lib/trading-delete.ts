import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  TRADING_BUSINESS_ID,
  recalculateTradingAccount,
  refreshTradingDailySnapshot,
} from '@/lib/trading'

type DeleteAuditEntry = {
  action: 'DELETE_APPROVED'
  actorUserId: string
  actorRole: string
  reason: string
  timestamp: string
  before?: Record<string, unknown>
}

function appendHistory(value: unknown, entry: DeleteAuditEntry): Prisma.InputJsonValue {
  const rows = Array.isArray(value) ? value.filter(row => row && typeof row === 'object') : []
  return [...rows, entry] as Prisma.InputJsonValue
}

function tradeSnapshot(trade: {
  tradeType: unknown
  usdtAmount: unknown
  bdtRate: unknown
  feeUsdt: unknown
  netBdt: unknown
  netProfit: unknown
  tradeDate: Date
  notes: string | null
}) {
  return {
    tradeType: String(trade.tradeType),
    usdtAmount: Number(trade.usdtAmount),
    bdtRate: Number(trade.bdtRate),
    feeUsdt: Number(trade.feeUsdt),
    netBdt: Number(trade.netBdt),
    netProfit: Number(trade.netProfit),
    tradeDate: trade.tradeDate.toISOString(),
    notes: trade.notes,
  }
}

/**
 * Soft-delete a trade and recalculate its account — the same logic the central
 * approval center runs on APPROVE. Extracted so a Super Admin can delete a trade
 * directly (their action is final, no approval queue) without duplicating the
 * transaction. Throws on invalid state; the caller maps that to an HTTP error.
 */
export async function commitTradeDeletion(input: {
  tradeId: string
  actorUserId: string
  actorRole: string
  reason: string
}) {
  const trade = await prisma.tradingTrade.findFirst({
    where: { id: input.tradeId, businessId: TRADING_BUSINESS_ID },
  })
  if (!trade) throw new Error('Trade not found')
  if (trade.deletedAt) throw new Error('Trade is already deleted')

  return prisma.$transaction(async tx => {
    const now = new Date()
    const updated = await tx.tradingTrade.update({
      where: { id: trade.id },
      data: {
        deletedAt: now,
        deletedBy: trade.deletedBy ?? input.actorUserId,
        deleteReason: trade.deleteReason ?? input.reason,
        deleteApprovedBy: input.actorUserId,
        deleteApprovedAt: now,
        editHistory: appendHistory(trade.editHistory, {
          action: 'DELETE_APPROVED',
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          reason: input.reason,
          timestamp: now.toISOString(),
          before: tradeSnapshot(trade),
        }),
      },
    })
    const summary = await recalculateTradingAccount(tx, trade.tradingAccountId)
    await refreshTradingDailySnapshot(tx, trade.tradingAccountId, trade.tradeDate, summary)
    return { trade: updated, summary }
  }, { maxWait: 10_000, timeout: 20_000 })
}
