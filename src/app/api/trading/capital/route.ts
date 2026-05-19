import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import {
  TRADING_BUSINESS_ID,
  getTradingContext,
  isResponse,
  moneyDecimal,
  parseCapitalEntryType,
  positiveMoneyDecimal,
  recalculateTradingAccount,
  refreshTradingDailySnapshot,
  requireTradingAdmin,
  requireTradingWrite,
} from '@/lib/trading'

export async function POST(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const writeDenied = requireTradingWrite(ctx)
  if (writeDenied) return writeDenied
  const adminDenied = requireTradingAdmin(ctx)
  if (adminDenied) return adminDenied

  try {
    const body = (await req.json()) as {
      tradingAccountId?: string
      entryType?: string
      amount?: number
      notes?: string
    }
    const tradingAccountId = String(body.tradingAccountId || '').trim()
    if (!tradingAccountId) return NextResponse.json({ error: 'tradingAccountId is required' }, { status: 400 })

    const entryType = parseCapitalEntryType(body.entryType)
    if (isResponse(entryType)) return entryType
    const rawAmount = Number(body.amount)
    if (!Number.isFinite(rawAmount) || rawAmount === 0) {
      return NextResponse.json({ error: 'amount must be a non-zero number' }, { status: 400 })
    }
    if (entryType !== 'ADJUSTMENT') {
      const validAmount = positiveMoneyDecimal(body.amount, 'amount')
      if (isResponse(validAmount)) return validAmount
    }
    const amount = moneyDecimal(rawAmount)

    const account = await prisma.tradingAccount.findFirst({
      where: { id: tradingAccountId, businessId: TRADING_BUSINESS_ID, deletedAt: null },
      select: { id: true },
    })
    if (!account) return NextResponse.json({ error: 'Trading account not found' }, { status: 404 })

    const result = await prisma.$transaction(async tx => {
      const capitalEntry = await tx.tradingCapitalEntry.create({
        data: {
          tradingAccountId,
          businessId: TRADING_BUSINESS_ID,
          entryType,
          amount,
          notes: String(body.notes || '').trim() || null,
          createdBy: ctx.userId,
        },
      })
      const summary = await recalculateTradingAccount(tx, tradingAccountId)
      await refreshTradingDailySnapshot(tx, tradingAccountId, new Date(), summary)
      return { capitalEntry, summary }
    })

    logEvent('info', 'trading.capital.added', {
      businessId: TRADING_BUSINESS_ID,
      accountId: tradingAccountId,
      capitalEntryId: result.capitalEntry.id,
      actorUserId: ctx.userId,
      entryType,
      amount: Number(result.capitalEntry.amount),
    })

    return NextResponse.json({ ok: true, ...result }, { status: 201 })
  } catch (e) {
    logEvent('error', 'trading.capital.add_failed', { actorUserId: ctx.userId, error: (e as Error).message })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
