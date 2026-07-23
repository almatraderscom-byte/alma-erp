import type { NotificationPriority, NotificationType, User, UserRole } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import { sendEmail } from '@/lib/resend'
import {
  ANDROID_NOTIFICATION_CHANNEL_ID,
  ANDROID_NOTIFICATION_SOUND_RAW,
  notificationSoundUrl,
} from '@/lib/notification-sound'
import { DEFAULT_ACTION_URL } from '@/lib/notification-routing'
import {
  categoryForNotificationType,
  filterUsersByNotificationPreference,
} from '@/lib/notification-preferences'

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

function absoluteActionUrl(actionUrl?: string | null, type?: NotificationType) {
  const base = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || 'https://alma-erp-six.vercel.app'
  const normalizedBase = base.startsWith('http') ? base : `https://${base}`
  // No explicit target → the type's home page (notification-routing.ts), not
  // the dashboard root — a tap should never silently dead-end.
  const effective = actionUrl || (type ? DEFAULT_ACTION_URL[type] : null)
  if (!effective) return normalizedBase
  if (/^https?:\/\//i.test(effective)) return effective
  return `${normalizedBase.replace(/\/$/, '')}/${effective.replace(/^\//, '')}`
}

function internalActionPath(actionUrl?: string | null, type?: NotificationType): string {
  const effective = actionUrl || (type ? DEFAULT_ACTION_URL[type] : null) || '/activity'
  if (!/^https?:\/\//i.test(effective)) {
    return effective.startsWith('/') ? effective : `/${effective}`
  }
  try {
    const url = new URL(effective)
    return `${url.pathname}${url.search}`
  } catch {
    return '/activity'
  }
}

function oneSignalResponseHasErrors(errors: unknown) {
  if (!errors) return false
  if (Array.isArray(errors)) return errors.length > 0
  if (typeof errors === 'object') return Object.keys(errors).length > 0
  return true
}

/**
 * External user ids OneSignal rejected ("invalid_aliases") — users with no
 * usable subscription. Both response shapes are handled:
 * `{errors: {invalid_aliases: {external_id: [...]}}}` and a top-level
 * `{invalid_aliases: {external_id: [...]}}`.
 */
function extractInvalidExternalIds(body: Record<string, unknown>): string[] {
  const candidates = [
    (body.errors as Record<string, unknown> | undefined)?.invalid_aliases,
    body.invalid_aliases,
  ]
  for (const candidate of candidates) {
    const ids = (candidate as { external_id?: unknown } | undefined)?.external_id
    if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === 'string')
  }
  return []
}

/** OneSignal dashboard channel UUID vs native Android channel id (see AlmaPushChannels.java). */
function resolveAndroidChannelFields(channelId?: string | null): Record<string, string> {
  const id = channelId?.trim()
  // Only honor a dashboard UUID override; any non-UUID env (e.g. a stale
  // "alma_alerts") is superseded by the current native channel constant so the
  // custom-sound fix works without editing Vercel env.
  if (id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { android_channel_id: id }
  }
  return { existing_android_channel_id: ANDROID_NOTIFICATION_CHANNEL_ID }
}

async function sendOneSignal(
  userIds: string[],
  title: string,
  message: string,
  priority: NotificationPriority,
  actionUrl: string | null | undefined,
  meta: { notificationId: string; businessId?: string | null; type: NotificationType },
) {
  const appId = process.env.ONESIGNAL_APP_ID || process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID
  const apiKey = process.env.ONESIGNAL_REST_API_KEY
  if (!appId || !apiKey || !userIds.length) return { configured: false, ok: false }

  const url = absoluteActionUrl(actionUrl, meta.type)
  const usesV2Key = apiKey.startsWith('os_v2_')

  const payload: Record<string, unknown> = {
    app_id: appId,
    target_channel: 'push',
    headings: { en: title },
    contents: { en: message },
    subtitle: meta.businessId ? { en: meta.businessId.replace(/_/g, ' ') } : undefined,
    // web_url drives browser push-subscribers (open a tab — correct on web).
    // We deliberately DO NOT set app_url: on native apps OneSignal would punt
    // that URL to the system browser. Native taps are routed in-app instead via
    // the click listener in native-push.ts using data.actionUrl below.
    web_url: url,
    priority: priority === 'LOW' ? 5 : 10,
    // Android 8+: sound comes from the alma_alerts_v2 channel (res/raw/alma_alert). android_sound API is deprecated.
    ...resolveAndroidChannelFields(process.env.ONESIGNAL_ANDROID_CHANNEL_ID),
    android_visibility: 1, // PUBLIC — show on lock screen
    android_led_color: 'FFC9A84C', // gold LED
    // iOS (APNs): bump the app icon badge on each push. Custom ios_sound is left
    // default — a matching .caf/.wav must be added to the Xcode bundle before we can set it.
    ios_badgeType: 'Increase',
    ios_badgeCount: 1,
    chrome_web_icon: `${absoluteActionUrl('/icon.svg')}`,
    chrome_web_badge: `${absoluteActionUrl('/maskable-icon.svg')}`,
    small_icon: 'ic_stat_onesignal_default',
    collapse_id: meta.notificationId,
    data: {
      priority,
      notificationId: meta.notificationId,
      businessId: meta.businessId || null,
      type: meta.type,
      actionUrl: url,
      // Native shells consume the relative route directly. This avoids the old
      // cold-start mismatch where the hidden Capacitor page had a capacitor://
      // origin but actionUrl used the production https:// origin, so the iOS
      // bridge was skipped and the invisible webview navigated instead.
      routePath: internalActionPath(actionUrl, meta.type),
      soundUrl: notificationSoundUrl(),
      androidSoundRaw: ANDROID_NOTIFICATION_SOUND_RAW,
    },
  }

  // Target all push subscriptions (web + native APK) tied to ERP user ids via OneSignal.login().
  if (usesV2Key) {
    payload.include_aliases = { external_id: userIds }
  } else {
    payload.include_external_user_ids = userIds
  }

  const res = await fetch(usesV2Key ? 'https://api.onesignal.com/notifications?c=push' : 'https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `${usesV2Key ? 'Key' : 'Basic'} ${apiKey}`,
    },
    body: JSON.stringify(payload),
  })
  const raw = await res.text()
  if (!res.ok) {
    logEvent('warn', 'onesignal_send_failed', { status: res.status, body: raw.slice(0, 300) })
    return { configured: true, ok: false, status: res.status }
  }

  let responseBody: { id?: string; errors?: unknown; recipients?: unknown } = {}
  try {
    responseBody = JSON.parse(raw) as typeof responseBody
  } catch {
    logEvent('warn', 'onesignal_send_failed', { status: res.status, body: raw.slice(0, 300), parseError: true })
    return { configured: true, ok: false, status: res.status }
  }

  if (oneSignalResponseHasErrors(responseBody.errors)) {
    const invalidExternalIds = extractInvalidExternalIds(responseBody as Record<string, unknown>)
    logEvent('warn', 'onesignal_send_partial_failure', {
      errors: responseBody.errors,
      recipients: responseBody.recipients,
      notificationId: responseBody.id,
      targetedUserIds: userIds,
      invalidAliases: (responseBody as Record<string, unknown>).invalid_aliases || null,
    })
    return { configured: true, ok: Boolean(responseBody.id), partialFailure: true, invalidExternalIds }
  }

  return { configured: true, ok: true, invalidExternalIds: [] as string[] }
}

export async function createNotification(input: NotifyInput) {
  const priority = input.priority || 'NORMAL'
  const recipients = await filterUsersByNotificationPreference(
    await resolveRecipients(input),
    priority,
    categoryForNotificationType(input.type),
  )
  const notification = await prisma.notification.create({
    data: {
      userId: input.userId || null,
      roleTarget: input.role || null,
      businessId: input.businessId || null,
      type: input.type,
      priority,
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
    priority,
    input.actionUrl,
    { notificationId: notification.id, businessId: input.businessId, type: input.type },
  )
  if (push.configured) {
    // Per-user truth: users OneSignal rejected (no usable subscription) are
    // FAILED even when the send as a whole succeeded — before this, one
    // aggregate flag marked everyone SENT and dead devices stayed invisible.
    const invalid = 'invalidExternalIds' in push ? push.invalidExternalIds || [] : []
    await prisma.notificationRecipient.updateMany({
      where: { notificationId: notification.id, ...(invalid.length ? { userId: { notIn: invalid } } : {}) },
      data: { pushStatus: push.ok ? 'SENT' : 'FAILED' },
    })
    if (invalid.length) {
      await prisma.notificationRecipient.updateMany({
        where: { notificationId: notification.id, userId: { in: invalid } },
        data: { pushStatus: 'FAILED' },
      })
    }
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

/**
 * Fan one event out to several roles (see NOTIFY_ROLES in
 * notification-routing.ts). Same behaviour as N notifyRole calls — one
 * Notification row per role, so per-role delivery stays independently tracked.
 */
export async function notifyRoles(roles: UserRole[], input: {
  businessId?: string | null
  type: NotificationType
  priority?: NotificationPriority
  title: string
  message: string
  actionUrl?: string | null
}) {
  return Promise.all(roles.map(role => createNotification({ ...input, role })))
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
