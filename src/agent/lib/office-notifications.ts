/**
 * Office notifications — the in-app bell/feed.
 *
 * Two buckets, by recipient convention on `office_notifications`:
 *  - owner bucket: recipientUserId AND recipientStaffId both null
 *  - staff bucket: recipientStaffId = the staff's id
 *
 * Read-only here plus a mark-read mutation. Telegram/ntfy mirroring of these
 * rows is best-effort and lives in office-notify.ts (fired at write time).
 */
import { prisma } from '@/lib/prisma'

export type OfficeNotice = {
  id: string
  taskId: string | null
  kind: string
  title: string
  body: string | null
  read: boolean
  createdAt: string
}

export type NotificationFeed = {
  unread: number
  items: OfficeNotice[]
}

export type NotifScope = { owner: true } | { owner: false; staffId: string }

function whereForScope(scope: NotifScope, businessId: string) {
  if (scope.owner) {
    return { businessId, recipientUserId: null, recipientStaffId: null }
  }
  return { businessId, recipientStaffId: scope.staffId }
}

export async function getNotificationFeed(
  scope: NotifScope,
  businessId = 'ALMA_LIFESTYLE',
  limit = 30,
): Promise<NotificationFeed> {
  const where = whereForScope(scope, businessId)
  const [rows, unread] = await Promise.all([
    prisma.officeNotification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, taskId: true, kind: true, title: true, body: true, read: true, createdAt: true },
    }),
    prisma.officeNotification.count({ where: { ...where, read: false } }),
  ])
  return {
    unread,
    items: rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      kind: r.kind,
      title: r.title,
      body: r.body,
      read: r.read,
      createdAt: r.createdAt.toISOString(),
    })),
  }
}

/** Mark notifications read — all for the scope, or a single id when given. */
export async function markNotificationsRead(
  scope: NotifScope,
  businessId: string,
  id?: string,
): Promise<number> {
  const where = whereForScope(scope, businessId)
  const res = await prisma.officeNotification.updateMany({
    where: { ...where, read: false, ...(id ? { id } : {}) },
    data: { read: true, readAt: new Date() },
  })
  return res.count
}
