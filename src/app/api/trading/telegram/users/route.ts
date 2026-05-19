import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID, getTradingContext, requireTradingAdmin, tradingAccountWhereForContext } from '@/lib/trading'

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const denied = requireTradingAdmin(ctx)
  if (denied) return denied

  const users = await prisma.tradingTelegramUser.findMany({
    where: { businessId: TRADING_BUSINESS_ID },
    include: { user: { select: { id: true, name: true, email: true, role: true, employeeIdGas: true, phone: true } } },
    orderBy: [{ approved: 'desc' }, { updatedAt: 'desc' }],
  })
  return NextResponse.json({ users })
}

export async function POST(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const denied = requireTradingAdmin(ctx)
  if (denied) return denied

  const body = (await req.json()) as {
    telegramUserId?: string
    telegramUsername?: string
    telegramFirstName?: string
    userId?: string
    approved?: boolean
    defaultAccountAlias?: string
    defaultTradingAccountId?: string
  }

  const telegramUserId = String(body.telegramUserId || '').trim()
  if (!telegramUserId) return NextResponse.json({ error: 'Telegram numeric user ID is required' }, { status: 400 })
  if (!/^\d+$/.test(telegramUserId)) {
    return NextResponse.json({ error: 'Telegram user ID must be numeric (use @userinfobot)' }, { status: 400 })
  }

  const erpUserId = String(body.userId || '').trim()
  if (!erpUserId) return NextResponse.json({ error: 'ERP staff member is required' }, { status: 400 })

  const erpUser = await prisma.user.findFirst({
    where: {
      id: erpUserId,
      active: true,
      businessAccess: { contains: TRADING_BUSINESS_ID },
    },
    select: { id: true, name: true },
  })
  if (!erpUser) {
    return NextResponse.json({ error: 'Selected staff member is not active or lacks Alma Trading access' }, { status: 400 })
  }

  let defaultTradingAccountId = body.defaultTradingAccountId?.trim() || null
  let defaultAccountAlias = body.defaultAccountAlias?.trim().toLowerCase() || null

  if (defaultTradingAccountId) {
    const account = await prisma.tradingAccount.findFirst({
      where: {
        id: defaultTradingAccountId,
        ...tradingAccountWhereForContext(ctx),
      },
      select: { id: true },
    })
    if (!account) {
      return NextResponse.json({ error: 'Selected trading account was not found' }, { status: 400 })
    }

    if (!defaultAccountAlias) {
      const aliasRow = await prisma.tradingAccountAlias.findFirst({
        where: {
          businessId: TRADING_BUSINESS_ID,
          tradingAccountId: defaultTradingAccountId,
          active: true,
        },
        orderBy: { alias: 'asc' },
        select: { alias: true },
      })
      if (aliasRow) defaultAccountAlias = aliasRow.alias
    }
  } else {
    defaultTradingAccountId = null
    defaultAccountAlias = defaultAccountAlias || null
  }

  const telegramUsername = body.telegramUsername?.trim().replace(/^@/, '') || null

  const user = await prisma.tradingTelegramUser.upsert({
    where: { businessId_telegramUserId: { businessId: TRADING_BUSINESS_ID, telegramUserId } },
    create: {
      businessId: TRADING_BUSINESS_ID,
      telegramUserId,
      telegramUsername,
      telegramFirstName: body.telegramFirstName?.trim() || null,
      userId: erpUserId,
      approved: Boolean(body.approved),
      defaultAccountAlias,
      defaultTradingAccountId,
    },
    update: {
      telegramUsername,
      telegramFirstName: body.telegramFirstName?.trim() || null,
      userId: erpUserId,
      approved: body.approved !== undefined ? Boolean(body.approved) : undefined,
      defaultAccountAlias,
      defaultTradingAccountId,
    },
    include: {
      user: { select: { id: true, name: true, email: true, role: true, employeeIdGas: true, phone: true } },
    },
  })

  return NextResponse.json({ ok: true, user }, { status: 201 })
}
