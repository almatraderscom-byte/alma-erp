import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID, getTradingContext, requireTradingVolumeTargetView } from '@/lib/trading'
import { targetDateUtc } from '@/lib/trading-volume-target'

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const viewDenied = requireTradingVolumeTargetView(ctx)
  if (viewDenied) return viewDenied

  const url = new URL(req.url)
  const month = url.searchParams.get('month')
  const start = month
    ? targetDateUtc(new Date(`${month}-01T12:00:00Z`))
    : targetDateUtc(new Date(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1))
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))

  const [targets, penalties] = await Promise.all([
    prisma.tradingDailyVolumeTarget.findMany({
      where: { businessId: TRADING_BUSINESS_ID, targetDate: { gte: start, lt: end } },
      select: { status: true, targetUsdt: true, actualUsdt: true },
    }),
    prisma.tradingVolumeTargetPenalty.findMany({
      where: { businessId: TRADING_BUSINESS_ID, createdAt: { gte: start, lt: end } },
      select: { status: true, appliedAmountBdt: true, waivedAmountBdt: true, employeeId: true },
    }),
  ])

  const missed = targets.filter(t => t.status === 'MISSED').length
  const met = targets.filter(t => t.status === 'MET').length
  const ignored = targets.filter(t => t.status === 'IGNORED').length
  const appliedPenalties = penalties.filter(p => p.status === 'APPLIED' || p.status === 'PARTIALLY_WAIVED')
  const totalApplied = appliedPenalties.reduce((s, p) => s + Number(p.appliedAmountBdt || 0), 0)
  const totalWaived = appliedPenalties.reduce((s, p) => s + Number(p.waivedAmountBdt || 0), 0)

  const repeatMap = new Map<string, number>()
  for (const p of appliedPenalties) {
    repeatMap.set(p.employeeId, (repeatMap.get(p.employeeId) || 0) + 1)
  }
  const repeatOffenders = [...repeatMap.entries()]
    .filter(([, c]) => c >= 2)
    .map(([employeeId, count]) => ({ employeeId, count }))
    .sort((a, b) => b.count - a.count)

  const payload = {
    month: start.toISOString().slice(0, 7),
    targetCount: targets.length,
    met,
    missed,
    ignored,
    totalAppliedBdt: totalApplied,
    totalWaivedBdt: totalWaived,
    netPenaltiesBdt: Math.max(0, totalApplied - totalWaived),
    repeatOffenders,
  }

  if (!ctx.isSuperAdmin) {
    return NextResponse.json({
      summary: {
        month: payload.month,
        targetCount: payload.targetCount,
        met: payload.met,
        missed: payload.missed,
        ignored: payload.ignored,
      },
      canManage: false,
    })
  }

  return NextResponse.json({ analytics: payload, canManage: true })
}
