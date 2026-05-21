import { NextRequest } from 'next/server'
import { assertAssigneesInBusinessScope } from '@/lib/operational-task-assignees'
import { createOperationalTask, listTasksForAdmin } from '@/lib/operational-tasks'
import { prisma } from '@/lib/prisma'
import { queueOperationalTaskAssigned } from '@/lib/operational-task-telegram'
import type { OperationalTaskPriority } from '@prisma/client'
import { withApiRoute, apiDataSuccess, apiFailure, requireJwtRoles, guardViewerWrite, parseJsonBody } from '@/lib/core/safe-route-helpers'

export const dynamic = 'force-dynamic'

export const GET = withApiRoute('operational_tasks.list', async (req: NextRequest) => {
  const auth = await requireJwtRoles(req, ['SUPER_ADMIN'])
  if (!auth.ok) return auth.response
  const businessId = new URL(req.url).searchParams.get('business_id')
  const tasks = await listTasksForAdmin(businessId)
  return apiDataSuccess({ tasks })
})

export const POST = withApiRoute('operational_tasks.create', async (req: NextRequest) => {
  const write = await guardViewerWrite(req)
  if (!write.ok) return write.response
  const auth = await requireJwtRoles(req, ['SUPER_ADMIN'])
  if (!auth.ok) return auth.response

  const body = await parseJsonBody<{
    title?: string
    description?: string
    priority?: OperationalTaskPriority
    banner_image_url?: string | null
    deadline?: string | null
    acknowledgment_required?: boolean
    allow_dismiss?: boolean
    show_on_check_in?: boolean
    business_id?: string | null
    assignee_user_ids?: string[]
  }>(req)

  const title = String(body.title || '').trim()
  const description = String(body.description || '').trim()
  const assigneeUserIds = Array.isArray(body.assignee_user_ids)
    ? [...new Set(body.assignee_user_ids.filter(Boolean))]
    : []

  if (!title || !description) {
    return apiFailure('invalid_request', 'Title and description are required.', { status: 400 })
  }
  if (!assigneeUserIds.length) {
    return apiFailure('invalid_request', 'Select at least one employee.', { status: 400 })
  }

  const businessId = String(body.business_id || '').trim()
  if (!businessId) {
    return apiFailure('invalid_request', 'business_id is required', { status: 400 })
  }

  const scope = await assertAssigneesInBusinessScope(businessId, assigneeUserIds, String(auth.token.sub))
  if (!scope.ok) return apiFailure('invalid_request', scope.error, { status: 400 })

  const task = await createOperationalTask(String(auth.token.sub), {
    title,
    description,
    priority: body.priority || 'NORMAL',
    bannerImageUrl: body.banner_image_url ?? null,
    deadline: body.deadline ?? null,
    acknowledgmentRequired: Boolean(body.acknowledgment_required),
    allowDismiss: body.allow_dismiss !== false,
    showOnCheckIn: Boolean(body.show_on_check_in),
    businessId,
    assigneeUserIds,
  })

  const users = await prisma.user.findMany({
    where: { id: { in: assigneeUserIds } },
    select: { id: true, name: true, email: true },
  })
  const nameById = new Map(users.map(u => [u.id, u.name || u.email]))

  for (const assignment of task.assignments) {
    await queueOperationalTaskAssigned({
      businessId: task.businessId,
      assignmentId: assignment.id,
      userId: assignment.userId,
      title: task.title,
      priority: task.priority,
      deadline: task.deadline,
      assigneeName: nameById.get(assignment.userId) || 'Employee',
    })
  }

  return apiDataSuccess({ taskId: task.id, task })
})
