import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  TRADING_BUSINESS_ID,
  getTradingContext,
  requireTradingSuperAdmin,
  requireTradingVolumeTargetView,
  usdtDecimal,
} from '@/lib/trading'
import {
  refreshTargetActualVolume,
  targetDateUtc,
  volumeTargetDto,
  writeVolumeTargetAudit,
} from '@/lib/trading-volume-target'

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const viewDenied = requireTradingVolumeTargetView(ctx)
  if (viewDenied) return viewDenied

  const url = new URL(req.url)
  const dateParam = url.searchParams.get('date')
  const day = dateParam ? targetDateUtc(new Date(`${dateParam}T12:00:00Z`)) : targetDateUtc()
  const status = url.searchParams.get('status') || undefined

  const rows = await prisma.tradingDailyVolumeTarget.findMany({
    where: {
      businessId: TRADING_BUSINESS_ID,
      targetDate: day,
      ...(status ? { status: status as never } : {}),
    },
    include: {
      tradingAccount: {
        include: { assignedUser: { select: { name: true, employeeIdGas: true } } },
      },
      penalties: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
    orderBy: { createdAt: 'desc' },
  })

  const refreshed = await Promise.all(rows.map(r => refreshTargetActualVolume(r.id)))
  const ids = refreshed.filter(Boolean).map(r => r!.id)
  const finalRows = ids.length
    ? await prisma.tradingDailyVolumeTarget.findMany({
        where: { id: { in: ids } },
        include: {
          tradingAccount: { include: { assignedUser: { select: { name: true, employeeIdGas: true } } } },
          penalties: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      })
    : rows

  return NextResponse.json({
    date: day.toISOString(),
    targets: finalRows.map(volumeTargetDto),
    canManage: ctx.isSuperAdmin,
  })
}

export async function POST(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const denied = requireTradingSuperAdmin(ctx)
  if (denied) return denied

  const body = (await req.json().catch(() => ({}))) as {
    trading_account_id?: string
    target_date?: string
    target_usdt?: number
    penalty_amount_bdt?: number
    notes?: string
  }

  const tradingAccountId = String(body.trading_account_id || '').trim()
  const targetUsdt = Number(body.target_usdt || 0)
  if (!tradingAccountId || !Number.isFinite(targetUsdt) || targetUsdt <= 0) {
    return NextResponse.json({ error: 'trading_account_id and target_usdt are required.' }, { status: 400 })
  }

  const account = await prisma.tradingAccount.findFirst({
    where: { id: tradingAccountId, businessId: TRADING_BUSINESS_ID, deletedAt: null },
    select: { id: true },
  })
  if (!account) return NextResponse.json({ error: 'Trading account not found.' }, { status: 404 })

  const targetDate = body.target_date ? targetDateUtc(new Date(`${body.target_date}T12:00:00Z`)) : targetDateUtc()

  try {
    const row = await prisma.tradingDailyVolumeTarget.create({
      data: {
        businessId: TRADING_BUSINESS_ID,
        tradingAccountId,
        targetDate,
        targetUsdt: usdtDecimal(targetUsdt),
        penaltyAmountBdt:
          body.penalty_amount_bdt == null ? null : new Prisma.Decimal(Number(body.penalty_amount_bdt).toFixed(2)),
        setById: ctx.userId,
        notes: String(body.notes || '').trim().slice(0, 1200) || null,
      },
      include: {
        tradingAccount: { include: { assignedUser: { select: { name: true, employeeIdGas: true } } } },
        penalties: true,
      },
    })
    await refreshTargetActualVolume(row.id)
    await writeVolumeTargetAudit(row.id, TRADING_BUSINESS_ID, 'TARGET_CREATED', ctx.userId, body.notes, {
      targetUsdt,
      targetDate: targetDate.toISOString(),
    })
    const fresh = await prisma.tradingDailyVolumeTarget.findUnique({
      where: { id: row.id },
      include: {
        tradingAccount: { include: { assignedUser: { select: { name: true, employeeIdGas: true } } } },
        penalties: { take: 1 },
      },
    })
    return NextResponse.json({ ok: true, target: volumeTargetDto(fresh!) })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return NextResponse.json({ error: 'A target already exists for this account and date.' }, { status: 409 })
    }
    throw e
  }
}
