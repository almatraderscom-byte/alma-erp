import type { OperationalTaskPriority } from '@prisma/client'
import { createNotification } from '@/lib/notifications'
import { scheduleTelegramNotificationAndFlush } from '@/lib/telegram-notification/queue'
import { erpBaseUrl } from '@/lib/telegram-notification/formatters'

const PRIORITY_LABEL: Record<OperationalTaskPriority, string> = {
  LOW: 'Low',
  NORMAL: 'Normal',
  HIGH: 'High',
  CRITICAL: 'Critical',
}

export function queueOperationalTaskAssigned(params: {
  businessId: string | null
  assignmentId: string
  userId: string
  title: string
  priority: OperationalTaskPriority
  deadline: Date | null
  assigneeName: string
}) {
  void createNotification({
    userId: params.userId,
    title: 'Operational task assigned',
    message: `${params.title} (${PRIORITY_LABEL[params.priority]}) — open My Desk after Start Work.`,
    actionUrl: '/portal',
    type: 'ADMIN_ANNOUNCEMENT',
    priority: params.priority === 'CRITICAL' || params.priority === 'HIGH' ? 'HIGH' : 'NORMAL',
  }).catch(() => {})

  const deadline = params.deadline
    ? ` · deadline ${params.deadline.toLocaleString('en-BD', { timeZone: 'Asia/Dhaka' })}`
    : ''
  scheduleTelegramNotificationAndFlush({
    businessId: params.businessId || 'ALMA_LIFESTYLE',
    eventType: 'OPERATIONAL_TASK_ASSIGNED',
    message: `📋 Task spotlight assigned to ${params.assigneeName}: ${params.title} (${PRIORITY_LABEL[params.priority]})${deadline}. ${erpBaseUrl()}/portal`,
    dedupeKey: `ops-task-assign:${params.assignmentId}`,
    metadata: { assignmentId: params.assignmentId, userId: params.userId },
  })
}

export function queueOperationalTaskStatusToAdmin(params: {
  businessId: string | null
  assignmentId: string
  title: string
  assigneeName: string
  action: 'ACKNOWLEDGED' | 'COMPLETED'
}) {
  const label = params.action === 'COMPLETED' ? 'completed' : 'acknowledged'
  scheduleTelegramNotificationAndFlush({
    businessId: params.businessId || 'ALMA_LIFESTYLE',
    eventType: 'OPERATIONAL_TASK_UPDATED',
    message: `📋 Task spotlight · ${label}: ${params.title} — ${params.assigneeName}. ${erpBaseUrl()}/operations/task-spotlight`,
    dedupeKey: `ops-task-${params.action.toLowerCase()}:${params.assignmentId}`,
    metadata: { assignmentId: params.assignmentId },
  })
}
