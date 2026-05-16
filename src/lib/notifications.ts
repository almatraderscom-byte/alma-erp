import type { NotificationPriority, NotificationType, User, UserRole } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import { sendEmail } from '@/lib/resend'

type NotifyInput = {
  userId?: string | null
  role?: UserRole | null
  businessId?: string | null
  type: NotificationType
  priority?: NotificationPriority
  title: string
  message: string
  actionUrl?: string | null
  pinned?: boolean
  metadata?: Record<string, unknown>
  createdById?: string | null
  broadcastId?: string | null
}

function businessWhere(businessId?: string | null) {
  return businessId ? { businessAccess: { contains: businessId } } : {}
}

async function resolveRecipients(input: NotifyInput) {
  if (input.userId) {
    const user = await prisma.user.findFirst({
      where: { id: input.userId, active: true },
      select: { id: true, businessAccess: true, email: true },
    })
    return user ? [user] : []
  }
  if (input.role) {
    return prisma.user.findMany({
      where: { active: true, role: input.role, ...businessWhere(input.businessId) },
      select: { id: true, businessAccess: true, email: true },
    })
  }
  return prisma.user.findMany({
    where: { active: true, ...businessWhere(input.businessId) },
    select: { id: true, businessAccess: true, email: true },
  })
}

async function sendOneSignal(userIds: string[], title: string, message: string, priority: NotificationPriority, actionUrl?: string | null) {
  const appId = process.env.ONESIGNAL_APP_ID
  const apiKey = process.env.ONESIGNAL_REST_API_KEY
  if (!appId || !apiKey || !userIds.length) return { configured: false, ok: false }

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId: { in: userIds }, provider: 'onesignal', enabled: true, playerId: { not: null } },
    select: { playerId: true },
  })
  const playerIds = subscriptions.map(s => s.playerId).filter(Boolean) as string[]
  if (!playerIds.length) return { configured: true, ok: false, reason: 'no_player_ids' }

  const res = await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${apiKey}`,
    },
    body: JSON.stringify({
      app_id: appId,
      include_player_ids: playerIds,
      headings: { en: title },
      contents: { en: message },
      url: actionUrl || undefined,
      priority: priority === 'LOW' ? 5 : 10,
      ios_sound: priority === 'LOW' ? undefined : 'default',
      android_sound: priority === 'LOW' ? undefined : 'default',
      android_channel_id: process.env.ONESIGNAL_ANDROID_CHANNEL_ID || undefined,
      data: { priority },
    }),
  })
  if (!res.ok) {
    logEvent('warn', 'onesignal_send_failed', { status: res.status, body: (await res.text()).slice(0, 300) })
    return { configured: true, ok: false, status: res.status }
  }
  return { configured: true, ok: true }
}

export async function createNotification(input: NotifyInput) {
  const recipients = await resolveRecipients(input)
  const notification = await prisma.notification.create({
    data: {
      userId: input.userId || null,
      roleTarget: input.role || null,
      businessId: input.businessId || null,
      type: input.type,
      priority: input.priority || 'NORMAL',
      title: input.title,
      message: input.message,
      actionUrl: input.actionUrl || null,
      pinned: input.pinned || input.priority === 'CRITICAL',
      metadataJson: input.metadata ? JSON.stringify(input.metadata).slice(0, 12000) : null,
      createdById: input.createdById || null,
      broadcastId: input.broadcastId || null,
    },
  })

  if (recipients.length) {
    await prisma.notificationRecipient.createMany({
      data: recipients.map((user: Pick<User, 'id' | 'businessAccess' | 'email'>) => ({
        notificationId: notification.id,
        userId: user.id,
        businessId: input.businessId || user.businessAccess.split(',')[0] || null,
        deliveryStatus: 'DELIVERED',
        deliveredAt: new Date(),
      })),
      skipDuplicates: true,
    })
  }

  const push = await sendOneSignal(
    recipients.map(r => r.id),
    input.title,
    input.message,
    input.priority || 'NORMAL',
    input.actionUrl,
  )
  if (push.configured) {
    await prisma.notificationRecipient.updateMany({
      where: { notificationId: notification.id },
      data: { pushStatus: push.ok ? 'SENT' : 'FAILED' },
    })
  }
  if (input.priority === 'HIGH' || input.priority === 'CRITICAL') {
    await Promise.all(recipients.map(async user => {
      const result = await sendEmail({
        to: user.email || '',
        subject: `[${input.priority}] ${input.title}`,
        title: input.title,
        preview: input.message,
        text: input.message,
        priority: input.priority,
        actionUrl: input.actionUrl || undefined,
        actionLabel: 'Open Alma ERP',
        notificationId: notification.id,
        recipientUserId: user.id,
      })
      if (!result.ok) {
        await prisma.notificationRecipient.updateMany({
          where: { notificationId: notification.id, userId: user.id },
          data: { emailStatus: 'FAILED', emailError: result.error || 'Email skipped' },
        })
      }
    }))
  }
  return notification
}

export async function notifyUser(input: {
  userId?: string | null
  businessId?: string | null
  type: NotificationType
  priority?: NotificationPriority
  title: string
  message: string
  actionUrl?: string | null
}) {
  if (!input.userId) return null
  return createNotification({ ...input })
}

export async function notifyRole(input: {
  role: UserRole
  businessId?: string | null
  type: NotificationType
  priority?: NotificationPriority
  title: string
  message: string
  actionUrl?: string | null
}) {
  return createNotification(input)
}

export async function notifyAdminsFailure(businessId: string, message: string) {
  await Promise.all([
    notifyRole({ role: 'SUPER_ADMIN', businessId, type: 'ACCRUAL_FAILED', priority: 'CRITICAL', title: 'Payroll accrual failed', message, actionUrl: '/payroll' }),
    notifyRole({ role: 'ADMIN', businessId, type: 'ACCRUAL_FAILED', priority: 'CRITICAL', title: 'Payroll accrual failed', message, actionUrl: '/payroll' }),
    notifyRole({ role: 'HR', businessId, type: 'ACCRUAL_FAILED', priority: 'CRITICAL', title: 'Payroll accrual failed', message, actionUrl: '/payroll' }),
  ])
}

export async function reminderCandidates(minutes = 30) {
  const cutoff = new Date(Date.now() - minutes * 60_000)
  return prisma.notificationRecipient.findMany({
    where: {
      acknowledgedAt: null,
      deliveredAt: { lt: cutoff },
      OR: [{ lastRemindedAt: null }, { lastRemindedAt: { lt: cutoff } }],
    },
    take: 100,
    orderBy: { deliveredAt: 'asc' },
  })
}
