import { NextRequest, NextResponse } from 'next/server'
import { getTradingContext, requireTradingSuperAdmin } from '@/lib/trading'
import {
  applyVolumeTargetPenalty,
  ignoreVolumeTargetFailure,
  refreshTargetActualVolume,
  volumeTargetDto,
  waiveVolumeTargetPenalty,
} from '@/lib/trading-volume-target'
import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID } from '@/lib/trading'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const denied = requireTradingSuperAdmin(ctx)
  if (denied) return denied

  const body = (await req.json().catch(() => ({}))) as {
    action?: 'APPLY_PENALTY' | 'WAIVE_PENALTY' | 'IGNORE' | 'REFRESH'
    amount_bdt?: number
    waive_amount_bdt?: number
    admin_note?: string
  }

  const action = body.action || 'REFRESH'

  if (action === 'REFRESH') {
    await refreshTargetActualVolume(params.id)
    const row = await prisma.tradingDailyVolumeTarget.findFirst({
      where: { id: params.id, businessId: TRADING_BUSINESS_ID },
      include: {
        tradingAccount: { include: { assignedUser: { select: { name: true, employeeIdGas: true } } } },
        penalties: { take: 1, orderBy: { createdAt: 'desc' } },
      },
    })
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true, target: volumeTargetDto(row) })
  }

  if (action === 'IGNORE') {
    const result = await ignoreVolumeTargetFailure(params.id, ctx.userId, body.admin_note)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
    const row = await prisma.tradingDailyVolumeTarget.findFirst({
      where: { id: params.id },
      include: {
        tradingAccount: { include: { assignedUser: { select: { name: true, employeeIdGas: true } } } },
        penalties: { take: 1, orderBy: { createdAt: 'desc' } },
      },
    })
    return NextResponse.json({ ok: true, target: volumeTargetDto(row!) })
  }

  if (action === 'APPLY_PENALTY') {
    const target = await prisma.tradingDailyVolumeTarget.findFirst({
      where: { id: params.id, businessId: TRADING_BUSINESS_ID },
    })
    const amount = body.amount_bdt ?? (target?.penaltyAmountBdt ? Number(target.penaltyAmountBdt) : 0)
    const result = await applyVolumeTargetPenalty(params.id, ctx.userId, Number(amount), body.admin_note)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
    const row = await prisma.tradingDailyVolumeTarget.findFirst({
      where: { id: params.id },
      include: {
        tradingAccount: { include: { assignedUser: { select: { name: true, employeeIdGas: true } } } },
        penalties: { take: 1, orderBy: { createdAt: 'desc' } },
      },
    })
    return NextResponse.json({ ok: true, target: volumeTargetDto(row!) })
  }

  if (action === 'WAIVE_PENALTY') {
    const penalty = await prisma.tradingVolumeTargetPenalty.findFirst({
      where: { targetId: params.id },
      orderBy: { createdAt: 'desc' },
    })
    const waive = body.waive_amount_bdt ?? Number(penalty?.appliedAmountBdt || 0)
    const result = await waiveVolumeTargetPenalty(params.id, ctx.userId, Number(waive), body.admin_note)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
    const row = await prisma.tradingDailyVolumeTarget.findFirst({
      where: { id: params.id },
      include: {
        tradingAccount: { include: { assignedUser: { select: { name: true, employeeIdGas: true } } } },
        penalties: { take: 1, orderBy: { createdAt: 'desc' } },
      },
    })
    return NextResponse.json({ target: volumeTargetDto(row!), ...result, ok: true })
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}
