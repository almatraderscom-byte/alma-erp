import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID, getTradingContext } from '@/lib/trading'
import { canViewTelegramMonitor } from '@/lib/trading-telegram-permissions'

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  if (!canViewTelegramMonitor(ctx)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const [pendingDeletes, staffPending, suspiciousAudits, statusCounts] = await Promise.all([
    prisma.tradingTrade.count({
      where: {
        businessId: TRADING_BUSINESS_ID,
        deletedAt: null,
        deleteReason: { not: null },
        deleteApprovedAt: null,
      },
    }),
    prisma.tradingTelegramDraft.groupBy({
      by: ['userId'],
      where: {
        businessId: TRADING_BUSINESS_ID,
        status: { in: ['PENDING', 'LOCKED'] },
        userId: { not: null },
      },
      _count: { _all: true },
    }),
    prisma.tradingTelegramAuditLog.findMany({
      where: {
        businessId: TRADING_BUSINESS_ID,
        eventType: { in: ['UNKNOWN_CHAT', 'UNAUTHORIZED_USER', 'RATE_LIMIT'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 15,
    }),
    prisma.tradingTelegramDraft.groupBy({
      by: ['status'],
      where: { businessId: TRADING_BUSINESS_ID },
      _count: { _all: true },
    }),
  ])

  const userIds = staffPending.map(s => s.userId).filter(Boolean) as string[]
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, role: true },
      })
    : []
  const userMap = new Map(users.map(u => [u.id, u]))

  const staffSummaries = staffPending
    .map(row => ({
      userId: row.userId,
      name: userMap.get(row.userId!)?.name ?? 'Unknown',
      role: userMap.get(row.userId!)?.role ?? null,
      pendingCount: row._count._all,
    }))
    .sort((a, b) => b.pendingCount - a.pendingCount)

  const counts = Object.fromEntries(statusCounts.map(s => [s.status, s._count._all]))

  return NextResponse.json({
    pendingDeleteApprovals: pendingDeletes,
    staffSummaries,
    suspiciousAudits,
    draftCounts: counts,
    serverTime: new Date().toISOString(),
  })
}
