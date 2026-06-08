import { prisma } from '@/lib/prisma'
import { DEFAULT_AGENT_BUSINESS_ID } from '@/lib/agent-api/constants'
import type { OperationalTaskPriority } from '@prisma/client'

const PRI_MAP: Record<string, OperationalTaskPriority> = {
  low: 'LOW',
  medium: 'NORMAL',
  high: 'HIGH',
  urgent: 'CRITICAL',
}

const PRI_REV: Record<OperationalTaskPriority, string> = {
  LOW: 'low',
  NORMAL: 'medium',
  HIGH: 'high',
  CRITICAL: 'urgent',
}

function mapTask(
  task: {
    id: string
    title: string
    description: string
    priority: OperationalTaskPriority
    deadline: Date | null
    createdAt: Date
    assignments: Array<{
      userId: string
      status: string
      user: { name: string; employeeIdGas: string | null }
    }>
  },
  fineAmount?: number | null,
) {
  const assign = task.assignments[0]
  const st = assign?.status === 'COMPLETED' ? 'completed' : assign?.status === 'ARCHIVED' ? 'cancelled' : 'pending'
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    assignedTo: assign?.user.employeeIdGas ?? assign?.userId ?? '',
    assignedToName: assign?.user.name,
    status: st as 'pending' | 'in_progress' | 'completed' | 'cancelled',
    priority: PRI_REV[task.priority] as 'low' | 'medium' | 'high' | 'urgent',
    dueAt: task.deadline?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    fineAmountIfMissed: fineAmount ?? null,
  }
}

export async function listTasks(input: {
  status?: string
  assignedTo?: string
  dueBefore?: string
  limit?: number
}) {
  const limit = input.limit ?? 50
  const now = input.dueBefore ? new Date(input.dueBefore) : undefined

  const tasks = await prisma.operationalTask.findMany({
    where: {
      status: 'ACTIVE',
      ...(now ? { deadline: { lte: now } } : {}),
      ...(input.assignedTo
        ? { assignments: { some: { user: { employeeIdGas: input.assignedTo } } } }
        : {}),
    },
    include: {
      assignments: {
        include: { user: { select: { id: true, name: true, employeeIdGas: true } } },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 50,
  })

  let mapped = tasks.map(t => mapTask(t))
  if (input.status) mapped = mapped.filter(t => t.status === input.status)
  mapped = mapped.slice(0, limit)

  return {
    tasks: mapped,
    meta: {
      count: mapped.length,
      limit,
      status: input.status ?? null,
      assignedTo: input.assignedTo ?? null,
      dueBefore: input.dueBefore ?? null,
    },
  }
}

export async function getTask(id: string) {
  const task = await prisma.operationalTask.findUnique({
    where: { id },
    include: {
      assignments: {
        include: { user: { select: { id: true, name: true, employeeIdGas: true } } },
      },
    },
  })
  if (!task) return null
  return mapTask(task)
}

export async function createTask(body: {
  title: string
  description?: string | null
  assignedTo: string
  dueAt: string
  priority?: string
  fineAmountIfMissed?: number | null
}) {
  const user = await prisma.user.findFirst({
    where: { employeeIdGas: body.assignedTo, active: true },
    select: { id: true },
  })
  if (!user) throw new Error('Assignee not found')

  const creator = await prisma.user.findFirst({
    where: { role: 'SUPER_ADMIN', active: true },
    select: { id: true },
  })
  if (!creator) throw new Error('No system user for task creation')

  const task = await prisma.operationalTask.create({
    data: {
      title: body.title,
      description: body.description ?? '',
      priority: PRI_MAP[body.priority ?? 'medium'] ?? 'NORMAL',
      deadline: new Date(body.dueAt),
      createdById: creator.id,
      businessId: DEFAULT_AGENT_BUSINESS_ID,
      assignments: {
        create: { userId: user.id, employeeIdGas: body.assignedTo },
      },
    },
  })

  return {
    id: task.id,
    status: 'created',
    createdAt: task.createdAt.toISOString(),
    fineAmountIfMissed: body.fineAmountIfMissed ?? null,
  }
}

export async function patchTask(id: string, body: Record<string, unknown>) {
  const data: Record<string, unknown> = {}
  if (body.title) data.title = body.title
  if (body.description !== undefined) data.description = body.description
  if (body.dueAt) data.deadline = new Date(String(body.dueAt))
  if (body.priority && typeof body.priority === 'string') {
    data.priority = PRI_MAP[body.priority] ?? 'NORMAL'
  }
  const task = await prisma.operationalTask.update({ where: { id }, data })
  return { id: task.id, status: 'updated', updatedAt: task.updatedAt.toISOString() }
}

export async function completeTask(id: string, body: { completionNote?: string | null; completedAt?: string }) {
  const assignment = await prisma.operationalTaskAssignment.findFirst({
    where: { taskId: id },
  })
  if (!assignment) throw new Error('Task assignment not found')
  await prisma.operationalTaskAssignment.update({
    where: { id: assignment.id },
    data: {
      status: 'COMPLETED',
      completedAt: body.completedAt ? new Date(body.completedAt) : new Date(),
    },
  })
  return { id, status: 'completed' }
}

export async function cancelTask(id: string) {
  await prisma.operationalTask.update({
    where: { id },
    data: { status: 'ARCHIVED' },
  })
  return { id, status: 'cancelled' }
}

export async function deleteTask(id: string) {
  const task = await prisma.operationalTask.findUnique({
    where: { id },
    include: { assignments: true },
  })
  if (!task) return null
  const pending = task.assignments.every(a => a.status === 'ACTIVE')
  if (!pending) throw new Error('Hard delete only allowed for pending tasks')
  await prisma.operationalTask.delete({ where: { id } })
  return { id, status: 'deleted' }
}
