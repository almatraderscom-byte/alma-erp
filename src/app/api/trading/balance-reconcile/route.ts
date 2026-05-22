import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import { TRADING_BUSINESS_ID, recalculateTradingAccount, refreshTradingDailySnapshot } from '@/lib/trading'

export const runtime = 'nodejs'
export const maxDuration = 60

function cronAuthorized(req: NextRequest) {
  const expectedSecret = process.env.TRADING_BALANCE_RECONCILE_SECRET || process.env.CRON_SECRET
  if (!expectedSecret) return false
  return req.headers.get('authorization') === `Bearer ${expectedSecret}`
}

async function reconcile(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const limit = Math.min(50, Math.max(1, Number(new URL(req.url).searchParams.get('limit') || 25)))
  const accounts = await prisma.tradingAccount.findMany({
    where: { businessId: TRADING_BUSINESS_ID, deletedAt: null },
    select: { id: true, accountTitle: true, currentBalance: true },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  })
  const repaired: Array<{ accountId: string; accountTitle: string; before: number; after: number; mismatch: number }> = []

  for (const account of accounts) {
    const result = await prisma.$transaction(async tx => {
      const summary = await recalculateTradingAccount(tx, account.id)
      await refreshTradingDailySnapshot(tx, account.id, new Date(), summary)
      return summary
    }, { maxWait: 10_000, timeout: 20_000 })
    const before = Number(account.currentBalance)
    const after = result.currentBalance
    const mismatch = Math.round((after - before) * 100) / 100
    if (Math.abs(mismatch) >= 0.01) {
      repaired.push({ accountId: account.id, accountTitle: account.accountTitle, before, after, mismatch })
    }
  }

  logEvent('info', 'trading.balance.reconciled', { checked: accounts.length, repaired: repaired.length })
  return NextResponse.json({ ok: true, checked: accounts.length, repaired })
}

export async function GET(req: NextRequest) {
  return reconcile(req)
}

export async function POST(req: NextRequest) {
  return reconcile(req)
}
