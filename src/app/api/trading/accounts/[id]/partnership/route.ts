import { NextRequest, NextResponse } from 'next/server'
import { logEvent } from '@/lib/logger'
import { prisma } from '@/lib/prisma'
import { computePartnershipPreview, listPartnershipSettlements } from '@/lib/trading-partnership'
import { TRADING_BUSINESS_ID, canAccessTradingAccount, getTradingContext } from '@/lib/trading'

type RouteContext = { params: { id: string } }

export async function GET(req: NextRequest, { params }: RouteContext) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error

  try {
    const account = await prisma.tradingAccount.findFirst({
      where: { id: params.id, businessId: TRADING_BUSINESS_ID, deletedAt: null },
      select: { id: true, assignedUserId: true, partnershipEnabled: true },
    })
    if (!account) return NextResponse.json({ error: 'Trading account not found' }, { status: 404 })
    if (!canAccessTradingAccount(ctx, account)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const [preview, history] = await Promise.all([
      computePartnershipPreview(params.id),
      listPartnershipSettlements(params.id),
    ])

    return NextResponse.json({ ok: true, preview, history }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    logEvent('error', 'trading.partnership.preview_failed', { actorUserId: ctx.userId, accountId: params.id, error: (e as Error).message })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
