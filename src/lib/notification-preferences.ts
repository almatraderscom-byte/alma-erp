import type { NotificationPriority, NotificationType } from '@prisma/client'
import { prisma } from '@/lib/prisma'

export type NotificationCategory =
  | 'agentCompletions'
  | 'approvals'
  | 'orders'
  | 'payrollWallet'
  | 'inventory'
  | 'finance'
  | 'announcements'

export type NotificationPreferenceSnapshot = {
  enabled: boolean
  highPriorityOnly: boolean
  criticalAlways: boolean
  agentCompletions: boolean
  approvals: boolean
  orders: boolean
  payrollWallet: boolean
  inventory: boolean
  finance: boolean
  announcements: boolean
}

export const DEFAULT_NOTIFICATION_PREFERENCE: NotificationPreferenceSnapshot = {
  enabled: true,
  highPriorityOnly: false,
  criticalAlways: true,
  agentCompletions: true,
  approvals: true,
  orders: true,
  payrollWallet: true,
  inventory: true,
  finance: true,
  announcements: true,
}

export const NOTIFICATION_PREFERENCE_KEYS = Object.keys(
  DEFAULT_NOTIFICATION_PREFERENCE,
) as Array<keyof NotificationPreferenceSnapshot>

export function categoryForNotificationType(type: NotificationType): NotificationCategory {
  switch (type) {
    case 'ORDER_ASSIGNED':
      return 'orders'
    case 'SALARY_ADDED':
    case 'ACCRUAL_FAILED':
    case 'WALLET_REQUEST_APPROVED':
    case 'WALLET_REQUEST_REJECTED':
    case 'PAYROLL_ALERT':
      return 'payrollWallet'
    case 'LOW_STOCK':
      return 'inventory'
    case 'EXPENSE_ADDED':
    case 'INVOICE_CREATED':
      return 'finance'
    case 'ADMIN_ANNOUNCEMENT':
    default:
      return 'announcements'
  }
}

export function notificationPreferenceAllows(
  preference: NotificationPreferenceSnapshot,
  priority: NotificationPriority,
  category: NotificationCategory,
): boolean {
  if (priority === 'CRITICAL' && preference.criticalAlways) return true
  if (!preference.enabled) return false
  if (preference.highPriorityOnly && priority !== 'HIGH' && priority !== 'CRITICAL') return false
  return preference[category]
}

export function withNotificationPreferenceDefaults(
  row?: Partial<NotificationPreferenceSnapshot> | null,
): NotificationPreferenceSnapshot {
  return { ...DEFAULT_NOTIFICATION_PREFERENCE, ...(row ?? {}) }
}

export async function getNotificationPreference(userId: string): Promise<NotificationPreferenceSnapshot> {
  const row = await prisma.notificationPreference.findUnique({
    where: { userId },
    select: {
      enabled: true,
      highPriorityOnly: true,
      criticalAlways: true,
      agentCompletions: true,
      approvals: true,
      orders: true,
      payrollWallet: true,
      inventory: true,
      finance: true,
      announcements: true,
    },
  })
  return withNotificationPreferenceDefaults(row)
}

export async function filterUsersByNotificationPreference<T extends { id: string }>(
  users: T[],
  priority: NotificationPriority,
  category: NotificationCategory,
): Promise<T[]> {
  if (!users.length) return []
  const rows = await prisma.notificationPreference.findMany({
    where: { userId: { in: users.map(user => user.id) } },
    select: {
      userId: true,
      enabled: true,
      highPriorityOnly: true,
      criticalAlways: true,
      agentCompletions: true,
      approvals: true,
      orders: true,
      payrollWallet: true,
      inventory: true,
      finance: true,
      announcements: true,
    },
  })
  const byUser = new Map(
    rows.map(row => [row.userId, withNotificationPreferenceDefaults(row)]),
  )
  return users.filter(user =>
    notificationPreferenceAllows(
      byUser.get(user.id) ?? DEFAULT_NOTIFICATION_PREFERENCE,
      priority,
      category,
    ),
  )
}

export async function filterAgentPushUserIds(
  userIds: string[],
  priority: NotificationPriority,
  category: Extract<NotificationCategory, 'agentCompletions' | 'approvals' | 'announcements'>,
): Promise<string[]> {
  const users = userIds.map(id => ({ id }))
  return (await filterUsersByNotificationPreference(users, priority, category)).map(user => user.id)
}
