import type {
  OperationalAssignmentStatus,
  OperationalTaskAckAction,
  OperationalTaskPriority,
} from '@prisma/client'
import { prisma } from '@/lib/prisma'

export const PRIORITY_RANK: Record<OperationalTaskPriority, number> = {
  CRITICAL: 4,
  HIGH: 3,
  NORMAL: 2,
  LOW: 1,
}

const OPEN_STATUSES: OperationalAssignmentStatus[] = ['ACTIVE', 'ACKNOWLEDGED', 'IN_PROGRESS']

export function isAssignmentOpen(status: OperationalAssignmentStatus): boolean {
  return OPEN_STATUSES.includes(status)
}

export function assignmentDto(
  row: {
    id: string
    status: OperationalAssignmentStatus
    acknowledgedAt: Date | null
    startedAt: Date | null
    completedAt: Date | null
    archivedAt: Date | null
    lastSpotlightAt: Date | null
    createdAt: Date
    updatedAt: Date
    userId: string
    employeeIdGas: string | null
    task: {
      id: string
      title: string
      description: string
      priority: OperationalTaskPriority
      bannerImageUrl: string | null
      deadline: Date | null
      acknowledgmentRequired: boolean
      allowDismiss: boolean
      showOnCheckIn: boolean
      status: string
      businessId: string | null
      createdAt: Date
      createdBy: { id: string; name: string | null; email: string | null }
    }
    user?: { id: string; name: string | null; email: string | null } | null
  },
) {
  const expired = row.task.deadline ? row.task.deadline.getTime() < Date.now() && row.status !== 'COMPLETED' : false
  return {
    id: row.id,
    taskId: row.task.id,
    userId: row.userId,
    employeeIdGas: row.employeeIdGas,
    status: expired && row.status !== 'EXPIRED' ? 'EXPIRED' : row.status,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    lastSpotlightAt: row.lastSpotlightAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    task: {
      id: row.task.id,
      title: row.task.title,
      description: row.task.description,
      priority: row.task.priority,
      bannerImageUrl: row.task.bannerImageUrl,
      deadline: row.task.deadline?.toISOString() ?? null,
      acknowledgmentRequired: row.task.acknowledgmentRequired,
      allowDismiss: row.task.allowDismiss,
      showOnCheckIn: row.task.showOnCheckIn,
      status: row.task.status,
      businessId: row.task.businessId,
      createdAt: row.task.createdAt.toISOString(),
      assignedBy: {
        id: row.task.createdBy.id,
        name: row.task.createdBy.name || row.task.createdBy.email,
      },
    },
    assignee: row.user
      ? { id: row.user.id, name: row.user.name || row.user.email, email: row.user.email }
      : null,
  }
}

const taskInclude = {
  createdBy: { select: { id: true, name: true, email: true } },
  assignments: {
    include: {
      user: { select: { id: true, name: true, email: true } },
      acknowledgements: { orderBy: { createdAt: 'desc' as const }, take: 5 },
    },
  },
} as const

export async function listTasksForAdmin(businessId?: string | null) {
  const rows = await prisma.operationalTask.findMany({
    where: {
      ...(businessId ? { OR: [{ businessId: null }, { businessId }] } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: taskInclude,
  })
  return rows.map(t => {
    const total = t.assignments.length
    const completed = t.assignments.filter(a => a.status === 'COMPLETED').length
    const acknowledged = t.assignments.filter(a =>
      ['ACKNOWLEDGED', 'IN_PROGRESS', 'COMPLETED'].includes(a.status),
    ).length
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      priority: t.priority,
      bannerImageUrl: t.bannerImageUrl,
      deadline: t.deadline?.toISOString() ?? null,
      acknowledgmentRequired: t.acknowledgmentRequired,
      allowDismiss: t.allowDismiss,
      showOnCheckIn: t.showOnCheckIn,
      status: t.status,
      businessId: t.businessId,
      createdAt: t.createdAt.toISOString(),
      createdBy: { id: t.createdBy.id, name: t.createdBy.name || t.createdBy.email },
      stats: {
        assigned: total,
        completed,
        acknowledged,
        completionRate: total ? Math.round((completed / total) * 100) : 0,
      },
      assignments: t.assignments.map(a => assignmentDto({ ...a, task: { ...t, createdBy: t.createdBy } })),
    }
  })
}

export async function listMyActiveTasks(userId: string, businessId: string) {
  await expireAssignmentsForUser(userId)
  const rows = await prisma.operationalTaskAssignment.findMany({
    where: {
      userId,
      status: { in: OPEN_STATUSES },
      task: {
        status: 'ACTIVE',
        OR: [{ businessId: null }, { businessId }],
      },
    },
    include: {
      task: { include: { createdBy: { select: { id: true, name: true, email: true } } } },
      user: { select: { id: true, name: true, email: true } },
    },
    take: 20,
  })
  return rows
    .map(r => assignmentDto(r))
    .sort((a, b) => PRIORITY_RANK[b.task.priority] - PRIORITY_RANK[a.task.priority])
}

export async function getSpotlightAssignment(userId: string, businessId: string) {
  await expireAssignmentsForUser(userId)
  const rows = await prisma.operationalTaskAssignment.findMany({
    where: {
      userId,
      status: { in: OPEN_STATUSES },
      task: {
        status: 'ACTIVE',
        showOnCheckIn: true,
        OR: [{ businessId: null }, { businessId }],
      },
    },
    include: {
      task: { include: { createdBy: { select: { id: true, name: true, email: true } } } },
    },
    take: 10,
  })
  if (!rows.length) return null
  const sorted = [...rows].sort(
    (a, b) => PRIORITY_RANK[b.task.priority] - PRIORITY_RANK[a.task.priority],
  )
  return assignmentDto(sorted[0]!)
}

async function expireAssignmentsForUser(userId: string) {
  const now = new Date()
  const stale = await prisma.operationalTaskAssignment.findMany({
    where: {
      userId,
      status: { in: OPEN_STATUSES },
      task: { deadline: { lt: now }, status: 'ACTIVE' },
    },
    select: { id: true },
  })
  if (!stale.length) return
  await prisma.$transaction([
    prisma.operationalTaskAssignment.updateMany({
      where: { id: { in: stale.map(s => s.id) } },
      data: { status: 'EXPIRED' },
    }),
    ...stale.map(s =>
      prisma.operationalTaskAcknowledgement.create({
        data: { assignmentId: s.id, userId, action: 'EXPIRED' },
      }),
    ),
  ])
}

export async function recordAck(
  assignmentId: string,
  userId: string,
  action: OperationalTaskAckAction,
  note?: string | null,
) {
  await prisma.operationalTaskAcknowledgement.create({
    data: { assignmentId, userId, action, note: note || null },
  })
}

export async function transitionAssignment(
  assignmentId: string,
  userId: string,
  action: 'acknowledge' | 'start' | 'complete' | 'dismiss',
) {
  const row = await prisma.operationalTaskAssignment.findFirst({
    where: { id: assignmentId, userId },
    include: { task: true },
  })
  if (!row || row.task.status !== 'ACTIVE') {
    return { error: 'Assignment not found', status: 404 as const }
  }
  if (!isAssignmentOpen(row.status)) {
    return { error: 'Task is no longer active', status: 409 as const }
  }

  const now = new Date()
  if (action === 'dismiss') {
    if (!row.task.allowDismiss) return { error: 'Dismiss not allowed for this task', status: 403 as const }
    await prisma.$transaction([
      prisma.operationalTaskAssignment.update({
        where: { id: assignmentId },
        data: { status: 'ARCHIVED', archivedAt: now },
      }),
      prisma.operationalTaskAcknowledgement.create({
        data: { assignmentId, userId, action: 'DISMISSED' },
      }),
    ])
    return { assignment: await reloadAssignment(assignmentId) }
  }

  if (action === 'acknowledge') {
    const nextStatus = row.status === 'ACTIVE' ? 'ACKNOWLEDGED' : row.status
    await prisma.$transaction([
      prisma.operationalTaskAssignment.update({
        where: { id: assignmentId },
        data: {
          status: nextStatus,
          acknowledgedAt: row.acknowledgedAt ?? now,
          lastSpotlightAt: now,
        },
      }),
      prisma.operationalTaskAcknowledgement.create({
        data: { assignmentId, userId, action: 'ACKNOWLEDGED' },
      }),
    ])
    return { assignment: await reloadAssignment(assignmentId) }
  }

  if (action === 'start') {
    await prisma.$transaction([
      prisma.operationalTaskAssignment.update({
        where: { id: assignmentId },
        data: {
          status: 'IN_PROGRESS',
          acknowledgedAt: row.acknowledgedAt ?? now,
          startedAt: row.startedAt ?? now,
          lastSpotlightAt: now,
        },
      }),
      prisma.operationalTaskAcknowledgement.create({
        data: { assignmentId, userId, action: 'STARTED' },
      }),
    ])
    return { assignment: await reloadAssignment(assignmentId) }
  }

  if (action === 'complete') {
    await prisma.$transaction([
      prisma.operationalTaskAssignment.update({
        where: { id: assignmentId },
        data: {
          status: 'COMPLETED',
          completedAt: now,
          acknowledgedAt: row.acknowledgedAt ?? now,
          startedAt: row.startedAt ?? now,
        },
      }),
      prisma.operationalTaskAcknowledgement.create({
        data: { assignmentId, userId, action: 'COMPLETED' },
      }),
    ])
    return { assignment: await reloadAssignment(assignmentId) }
  }

  return { error: 'Unknown action', status: 400 as const }
}

async function reloadAssignment(assignmentId: string) {
  const row = await prisma.operationalTaskAssignment.findUnique({
    where: { id: assignmentId },
    include: {
      task: { include: { createdBy: { select: { id: true, name: true, email: true } } } },
      user: { select: { id: true, name: true, email: true } },
    },
  })
  return row ? assignmentDto(row) : null
}

export async function markSpotlightShown(assignmentId: string, userId: string) {
  await prisma.operationalTaskAssignment.updateMany({
    where: { id: assignmentId, userId },
    data: { lastSpotlightAt: new Date() },
  })
}

export async function archiveOpenAssignmentsOnCheckout(userId: string) {
  const now = new Date()
  const open = await prisma.operationalTaskAssignment.findMany({
    where: { userId, status: { in: ['ACTIVE', 'ACKNOWLEDGED', 'IN_PROGRESS'] } },
    select: { id: true },
  })
  if (!open.length) return 0
  await prisma.$transaction([
    prisma.operationalTaskAssignment.updateMany({
      where: { id: { in: open.map(o => o.id) } },
      data: { status: 'ARCHIVED', archivedAt: now },
    }),
    ...open.map(o =>
      prisma.operationalTaskAcknowledgement.create({
        data: { assignmentId: o.id, userId, action: 'ARCHIVED', note: 'end_work' },
      }),
    ),
  ])
  return open.length
}

export async function resendSpotlight(assignmentId: string) {
  await prisma.operationalTaskAssignment.update({
    where: { id: assignmentId },
    data: { lastSpotlightAt: null, status: 'ACTIVE' },
  })
}

export type CreateTaskInput = {
  title: string
  description: string
  priority?: OperationalTaskPriority
  bannerImageUrl?: string | null
  deadline?: string | null
  acknowledgmentRequired?: boolean
  allowDismiss?: boolean
  showOnCheckIn?: boolean
  businessId?: string | null
  assigneeUserIds: string[]
}

export async function createOperationalTask(createdById: string, input: CreateTaskInput) {
  const assignees = await prisma.user.findMany({
    where: { id: { in: input.assigneeUserIds } },
    select: { id: true, employeeIdGas: true },
  })

  const task = await prisma.operationalTask.create({
    data: {
      title: input.title.trim(),
      description: input.description.trim(),
      priority: input.priority || 'NORMAL',
      bannerImageUrl: input.bannerImageUrl || null,
      deadline: input.deadline ? new Date(input.deadline) : null,
      acknowledgmentRequired: input.acknowledgmentRequired ?? true,
      allowDismiss: input.allowDismiss ?? false,
      showOnCheckIn: input.showOnCheckIn ?? true,
      businessId: input.businessId || null,
      createdById,
      assignments: {
        create: assignees.map(u => ({
          userId: u.id,
          employeeIdGas: u.employeeIdGas,
          status: 'ACTIVE',
        })),
      },
    },
    include: taskInclude,
  })

  const acks = task.assignments.map(a =>
    prisma.operationalTaskAcknowledgement.create({
      data: { assignmentId: a.id, userId: a.userId, action: 'ASSIGNED' },
    }),
  )
  await prisma.$transaction(acks)

  return task
}
