import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext, forbidden } from '@/lib/payroll-wallet-access'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const ctx = await getWalletContext(req)
  if ('error' in ctx) return ctx.error
  if (!ctx.isAdmin) return forbidden('Only admins can view notification analytics.')

  const [broadcasts, total, delivered, seen, read, acknowledged, criticalOpen] = await Promise.all([
    prisma.notificationBroadcast.findMany({ orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.notificationRecipient.count(),
    prisma.notificationRecipient.count({ where: { deliveredAt: { not: null } } }),
    prisma.notificationRecipient.count({ where: { seenAt: { not: null } } }),
    prisma.notificationRecipient.count({ where: { readAt: { not: null } } }),
    prisma.notificationRecipient.count({ where: { acknowledgedAt: { not: null } } }),
    prisma.notification.count({ where: { priority: 'CRITICAL' } }),
  ])

  const byBroadcast = await Promise.all(broadcasts.map(async b => {
    const notificationIds = (await prisma.notification.findMany({ where: { broadcastId: b.id }, select: { id: true } })).map(n => n.id)
    const where = { notificationId: { in: notificationIds } }
    const [recipients, deliveredCount, seenCount, acknowledgedCount] = await Promise.all([
      prisma.notificationRecipient.count({ where }),
      prisma.notificationRecipient.count({ where: { ...where, deliveredAt: { not: null } } }),
      prisma.notificationRecipient.count({ where: { ...where, seenAt: { not: null } } }),
      prisma.notificationRecipient.count({ where: { ...where, acknowledgedAt: { not: null } } }),
    ])
    return { ...b, recipients, delivered: deliveredCount, seen: seenCount, acknowledged: acknowledgedCount }
  }))

  return NextResponse.json({
    totals: {
      recipients: total,
      delivered,
      seen,
      read,
      acknowledged,
      openRate: total ? Math.round((seen / total) * 100) : 0,
      ackRate: total ? Math.round((acknowledged / total) * 100) : 0,
      criticalOpen,
    },
    broadcasts: byBroadcast,
  })
}
