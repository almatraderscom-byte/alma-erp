import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID, getTradingContext, requireTradingAdmin } from '@/lib/trading'

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const denied = requireTradingAdmin(ctx)
  if (denied) return denied

  const aliases = await prisma.tradingAccountAlias.findMany({
    where: { businessId: TRADING_BUSINESS_ID },
    include: { tradingAccount: { select: { id: true, accountTitle: true, status: true } } },
    orderBy: { alias: 'asc' },
  })
  return NextResponse.json({ aliases })
}

export async function POST(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const denied = requireTradingAdmin(ctx)
  if (denied) return denied

  const body = (await req.json()) as { alias?: string; tradingAccountId?: string; active?: boolean }
  const alias = String(body.alias || '').trim().toLowerCase()
  const tradingAccountId = String(body.tradingAccountId || '').trim()
  if (!alias || !/^[a-z0-9_-]{1,16}$/.test(alias)) {
    return NextResponse.json({ error: 'alias must be 1-16 chars (a-z, 0-9, _, -)' }, { status: 400 })
  }
  if (!tradingAccountId) return NextResponse.json({ error: 'tradingAccountId required' }, { status: 400 })

  const account = await prisma.tradingAccount.findFirst({
    where: { id: tradingAccountId, businessId: TRADING_BUSINESS_ID, deletedAt: null },
  })
  if (!account) return NextResponse.json({ error: 'Trading account not found' }, { status: 404 })

  const row = await prisma.tradingAccountAlias.upsert({
    where: { businessId_alias: { businessId: TRADING_BUSINESS_ID, alias } },
    create: {
      businessId: TRADING_BUSINESS_ID,
      alias,
      tradingAccountId,
      active: body.active !== false,
    },
    update: {
      tradingAccountId,
      active: body.active !== undefined ? Boolean(body.active) : true,
    },
    include: { tradingAccount: { select: { id: true, accountTitle: true, status: true } } },
  })

  return NextResponse.json({ ok: true, alias: row }, { status: 201 })
}
