import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'

export async function GET(req: NextRequest) {
  const ctx = await getWalletContext(req)
  if ('error' in ctx) return ctx.error
  const url = new URL(req.url)
  const q = (url.searchParams.get('q') || '').trim()
  const status = url.searchParams.get('status') || 'all'
  const priority = url.searchParams.get('priority') || 'all'
  const businessId = url.searchParams.get('business_id') || undefined
  const allowedBusinessIds = businessId ? [businessId] : ctx.businessIds
  const recipientIds = (await prisma.notificationRecipient.findMany({
    where: {
      userId: ctx.userId,
      OR: [{ businessId: { in: allowedBusinessIds } }, { businessId: null }],
    },
    select: { notificationId: true },
  })).map(r => r.notificationId)

  const notifications = await prisma.notification.findMany({
    where: {
      AND: [
        { OR: [{ businessId: { in: allowedBusinessIds } }, { businessId: null }] },
        priority !== 'all' ? { priority: priority as never } : {},
        q ? { OR: [{ title: { contains: q, mode: 'insensitive' } }, { message: { contains: q, mode: 'insensitive' } }] } : {},
        {
          OR: [
            { userId: ctx.userId },
            { roleTarget: ctx.role },
            { id: { in: recipientIds } },
          ],
        },
      ],
    },
    orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
    take: 100,
  })
  const recipientRows = await prisma.notificationRecipient.findMany({
    where: { userId: ctx.userId, notificationId: { in: notifications.map(n => n.id) } },
  })
  const recipientMap = new Map(recipientRows.map(r => [r.notificationId, r]))
  const enriched = notifications
    .map(n => ({ ...n, recipient: recipientMap.get(n.id) || null }))
    .filter(n => {
      if (status === 'unread') return !n.recipient?.readAt && !n.readAt
      if (status === 'ack') return Boolean(n.recipient?.acknowledgedAt)
      if (status === 'needs_ack') return n.priority === 'CRITICAL' && !n.recipient?.acknowledgedAt
      return true
    })

  await prisma.notificationRecipient.updateMany({
    where: { userId: ctx.userId, notificationId: { in: enriched.map(n => n.id) }, seenAt: null },
    data: { seenAt: new Date() },
  })

  return NextResponse.json({
    notifications: enriched,
    unread: enriched.filter(n => !n.recipient?.readAt && !n.readAt).length,
    criticalUnacked: enriched.filter(n => n.priority === 'CRITICAL' && !n.recipient?.acknowledgedAt).length,
  })
}

export async function PATCH(req: NextRequest) {
  const ctx = await getWalletContext(req)
  if ('error' in ctx) return ctx.error
  const body = (await req.json().catch(() => ({}))) as { id?: string; all?: boolean; action?: 'read' | 'unread' | 'ack' | 'pin' | 'unpin' }
  const now = new Date()
  if (body.all) {
    await prisma.notification.updateMany({
      where: { userId: ctx.userId, readAt: null },
      data: { readAt: now },
    })
    await prisma.notificationRecipient.updateMany({
      where: { userId: ctx.userId, readAt: null },
      data: { readAt: now, seenAt: now },
    })
    return NextResponse.json({ ok: true })
  }
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  if (body.action === 'pin' || body.action === 'unpin') {
    if (!['SUPER_ADMIN', 'ADMIN'].includes(ctx.role)) {
      return NextResponse.json({ error: 'Only admins can pin shared notifications.' }, { status: 403 })
    }
    await prisma.notification.updateMany({
      where: { id: body.id, OR: [{ userId: ctx.userId }, { roleTarget: ctx.role }] },
      data: { pinned: body.action === 'pin' },
    })
    return NextResponse.json({ ok: true })
  }
  const data =
    body.action === 'unread' ? { readAt: null }
    : body.action === 'ack' ? { acknowledgedAt: now, readAt: now, seenAt: now }
    : { readAt: now, seenAt: now }
  await prisma.notificationRecipient.upsert({
    where: { notificationId_userId: { notificationId: body.id, userId: ctx.userId } },
    update: data,
    create: {
      notificationId: body.id,
      userId: ctx.userId,
      deliveryStatus: 'DELIVERED',
      deliveredAt: now,
      seenAt: now,
      ...data,
    },
  })
  await prisma.notification.updateMany({ where: { id: body.id, userId: ctx.userId }, data: body.action === 'unread' ? { readAt: null } : { readAt: now } })
  return NextResponse.json({ ok: true })
}
