import { NextRequest, NextResponse } from 'next/server'
import { logEvent } from '@/lib/logger'
import { prisma } from '@/lib/prisma'
import { executePartnershipSettlement } from '@/lib/trading-partnership'
import { TRADING_BUSINESS_ID, canAccessTradingAccount, getTradingContext, requireTradingAdmin } from '@/lib/trading'

type RouteContext = { params: { id: string } }

export async function POST(req: NextRequest, { params }: RouteContext) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const adminDenied = requireTradingAdmin(ctx)
  if (adminDenied) return adminDenied

  try {
    const account = await prisma.tradingAccount.findFirst({
      where: { id: params.id, businessId: TRADING_BUSINESS_ID, deletedAt: null },
      select: { id: true, assignedUserId: true, partnershipEnabled: true },
    })
    if (!account) return NextResponse.json({ error: 'Trading account not found' }, { status: 404 })
    if (!canAccessTradingAccount(ctx, account)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (!account.partnershipEnabled) {
      return NextResponse.json({ error: 'Partnership is not enabled on this account' }, { status: 400 })
    }

    const body = (await req.json()) as {
      notes?: string
      adminOverrideBdt?: number | null
      postToWallet?: boolean
    }

    const result = await executePartnershipSettlement(params.id, {
      settledByUserId: ctx.userId,
      notes: body.notes,
      adminOverrideBdt: body.adminOverrideBdt,
      postToWallet: Boolean(body.postToWallet),
    })

    logEvent('info', 'trading.partnership.settled', {
      businessId: TRADING_BUSINESS_ID,
      accountId: params.id,
      settlementId: result.settlement.id,
      netStaffOwesBdt: result.finalNetStaffOwes,
      actorUserId: ctx.userId,
      postedToWallet: Boolean(result.ledgerEntryId),
    })

    return NextResponse.json({ ok: true, settlement: result.settlement, ledgerEntryId: result.ledgerEntryId })
  } catch (e) {
    logEvent('error', 'trading.partnership.settle_failed', { actorUserId: ctx.userId, accountId: params.id, error: (e as Error).message })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
