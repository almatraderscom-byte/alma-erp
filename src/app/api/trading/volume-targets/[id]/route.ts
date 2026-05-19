import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID, getTradingContext, requireTradingSuperAdmin, usdtDecimal } from '@/lib/trading'
import { refreshTargetActualVolume, volumeTargetDto, writeVolumeTargetAudit } from '@/lib/trading-volume-target'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const denied = requireTradingSuperAdmin(ctx)
  if (denied) return denied

  const body = (await req.json().catch(() => ({}))) as {
    target_usdt?: number
    penalty_amount_bdt?: number | null
    notes?: string | null
  }

  const existing = await prisma.tradingDailyVolumeTarget.findFirst({
    where: { id: params.id, businessId: TRADING_BUSINESS_ID },
  })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const data: Prisma.TradingDailyVolumeTargetUpdateInput = {}
  if (body.target_usdt !== undefined) data.targetUsdt = usdtDecimal(Number(body.target_usdt))
  if (body.penalty_amount_bdt !== undefined) {
    data.penaltyAmountBdt =
      body.penalty_amount_bdt == null ? null : new Prisma.Decimal(Number(body.penalty_amount_bdt).toFixed(2))
  }
  if (body.notes !== undefined) data.notes = body.notes ? String(body.notes).slice(0, 1200) : null

  await prisma.tradingDailyVolumeTarget.update({ where: { id: params.id }, data })
  await refreshTargetActualVolume(params.id)
  await writeVolumeTargetAudit(params.id, TRADING_BUSINESS_ID, 'TARGET_UPDATED', ctx.userId, body.notes || undefined, body)

  const fresh = await prisma.tradingDailyVolumeTarget.findUnique({
    where: { id: params.id },
    include: {
      tradingAccount: { include: { assignedUser: { select: { name: true, employeeIdGas: true } } } },
      penalties: { take: 1, orderBy: { createdAt: 'desc' } },
    },
  })
  return NextResponse.json({ ok: true, target: volumeTargetDto(fresh!) })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const denied = requireTradingSuperAdmin(ctx)
  if (denied) return denied

  const existing = await prisma.tradingDailyVolumeTarget.findFirst({
    where: { id: params.id, businessId: TRADING_BUSINESS_ID },
    include: { penalties: { where: { status: { in: ['APPLIED', 'PARTIALLY_WAIVED'] } } } },
  })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (existing.penalties.length) {
    return NextResponse.json({ error: 'Cannot delete a target with an applied penalty. Waive the penalty first.' }, { status: 409 })
  }

  await writeVolumeTargetAudit(params.id, TRADING_BUSINESS_ID, 'TARGET_DELETED', ctx.userId)
  await prisma.tradingDailyVolumeTarget.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
