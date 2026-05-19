import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import {
  TRADING_BUSINESS_ID,
  canAccessTradingAccount,
  getTradingContext,
  isResponse,
  parseTradingDate,
  positiveMoneyDecimal,
  recalculateTradingAccount,
  refreshTradingDailySnapshot,
  requireTradingWrite,
} from '@/lib/trading'

export async function POST(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const writeDenied = requireTradingWrite(ctx)
  if (writeDenied) return writeDenied

  try {
    const body = (await req.json()) as {
      tradingAccountId?: string
      expenseType?: string
      amount?: number
      notes?: string
      attachmentUrl?: string
      expenseDate?: string
    }
    const tradingAccountId = String(body.tradingAccountId || '').trim()
    const expenseType = String(body.expenseType || '').trim()
    if (!tradingAccountId) return NextResponse.json({ error: 'tradingAccountId is required' }, { status: 400 })
    if (!expenseType) return NextResponse.json({ error: 'expenseType is required' }, { status: 400 })

    const account = await prisma.tradingAccount.findFirst({
      where: { id: tradingAccountId, businessId: TRADING_BUSINESS_ID, deletedAt: null },
      select: { id: true, assignedUserId: true },
    })
    if (!account) return NextResponse.json({ error: 'Trading account not found' }, { status: 404 })
    if (!canAccessTradingAccount(ctx, account)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const amount = positiveMoneyDecimal(body.amount, 'amount')
    if (isResponse(amount)) return amount
    const expenseDate = parseTradingDate(body.expenseDate, 'expenseDate')
    if (isResponse(expenseDate)) return expenseDate

    const result = await prisma.$transaction(async tx => {
      const expense = await tx.tradingExpense.create({
        data: {
          tradingAccountId,
          businessId: TRADING_BUSINESS_ID,
          expenseType,
          amount,
          notes: String(body.notes || '').trim() || null,
          attachmentUrl: String(body.attachmentUrl || '').trim() || null,
          expenseDate,
          createdBy: ctx.userId,
        },
      })
      await refreshTradingDailySnapshot(tx, tradingAccountId, expenseDate)
      const summary = await recalculateTradingAccount(tx, tradingAccountId)
      return { expense, summary }
    })

    logEvent('info', 'trading.expense.added', {
      businessId: TRADING_BUSINESS_ID,
      accountId: tradingAccountId,
      expenseId: result.expense.id,
      actorUserId: ctx.userId,
      amount: Number(result.expense.amount),
      expenseType,
    })

    return NextResponse.json({ ok: true, ...result }, { status: 201 })
  } catch (e) {
    logEvent('error', 'trading.expense.add_failed', { actorUserId: ctx.userId, error: (e as Error).message })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
