import { NextRequest, NextResponse } from 'next/server'
import type { NotificationPriority, UserRole } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { createNotification } from '@/lib/notifications'
import { getWalletContext, forbidden } from '@/lib/payroll-wallet-access'

export async function POST(req: NextRequest) {
  const ctx = await getWalletContext(req)
  if ('error' in ctx) return ctx.error
  if (!ctx.isAdmin) return forbidden('Only admins can broadcast notifications.')

  const body = (await req.json()) as {
    title?: string
    message?: string
    priority?: NotificationPriority
    target?: 'ALL' | 'ROLE' | 'BUSINESS' | 'USER'
    targetRole?: UserRole
    targetBusinessId?: string
    targetUserId?: string
    actionUrl?: string
    pinned?: boolean
  }
  if (!body.title?.trim() || !body.message?.trim()) {
    return NextResponse.json({ error: 'title and message required' }, { status: 400 })
  }
  const target = body.target || 'ALL'
  if (target === 'ROLE' && !body.targetRole) return NextResponse.json({ error: 'targetRole required' }, { status: 400 })
  if (target === 'BUSINESS' && !body.targetBusinessId) return NextResponse.json({ error: 'targetBusinessId required' }, { status: 400 })
  if (target === 'USER' && !body.targetUserId) return NextResponse.json({ error: 'targetUserId required' }, { status: 400 })

  const broadcast = await prisma.notificationBroadcast.create({
    data: {
      title: body.title.trim().slice(0, 160),
      message: body.message.trim().slice(0, 2000),
      priority: body.priority || 'NORMAL',
      target,
      targetRole: target === 'ROLE' ? body.targetRole! : null,
      targetBusinessId: target === 'BUSINESS' ? body.targetBusinessId! : null,
      targetUserId: target === 'USER' ? body.targetUserId! : null,
      actionUrl: body.actionUrl || null,
      pinned: body.pinned || body.priority === 'CRITICAL',
      createdById: ctx.userId,
    },
  })

  const notification = await createNotification({
    userId: target === 'USER' ? body.targetUserId : null,
    role: target === 'ROLE' ? body.targetRole : null,
    businessId: target === 'BUSINESS' ? body.targetBusinessId : null,
    type: 'ADMIN_ANNOUNCEMENT',
    priority: body.priority || 'NORMAL',
    title: broadcast.title,
    message: broadcast.message,
    actionUrl: body.actionUrl || null,
    pinned: broadcast.pinned,
    createdById: ctx.userId,
    broadcastId: broadcast.id,
  })
  const recipients = await prisma.notificationRecipient.count({ where: { notificationId: notification.id } })
  return NextResponse.json({ ok: true, broadcast, notification, recipients })
}
