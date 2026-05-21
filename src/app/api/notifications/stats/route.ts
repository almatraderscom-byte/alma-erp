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

  const broadcastIds = broadcasts.map(b => b.id)
  const notifications = broadcastIds.length
    ? await prisma.notification.findMany({
        where: { broadcastId: { in: broadcastIds } },
        select: { id: true, broadcastId: true },
      })
    : []
  const notificationToBroadcast = new Map(notifications.map(n => [n.id, n.broadcastId]))
  const recipientRows = notifications.length
    ? await prisma.notificationRecipient.findMany({
        where: { notificationId: { in: notifications.map(n => n.id) } },
        select: { notificationId: true, deliveredAt: true, seenAt: true, acknowledgedAt: true },
      })
    : []
  const statsByBroadcast = new Map<string, { recipients: number; delivered: number; seen: number; acknowledged: number }>()
  for (const row of recipientRows) {
    const broadcastId = notificationToBroadcast.get(row.notificationId)
    if (!broadcastId) continue
    const stats = statsByBroadcast.get(broadcastId) || { recipients: 0, delivered: 0, seen: 0, acknowledged: 0 }
    stats.recipients += 1
    if (row.deliveredAt) stats.delivered += 1
    if (row.seenAt) stats.seen += 1
    if (row.acknowledgedAt) stats.acknowledged += 1
    statsByBroadcast.set(broadcastId, stats)
  }

  const byBroadcast = broadcasts.map(b => ({ ...b, ...(statsByBroadcast.get(b.id) || { recipients: 0, delivered: 0, seen: 0, acknowledged: 0 }) }))

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
