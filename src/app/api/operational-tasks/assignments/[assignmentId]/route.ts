import { NextRequest } from 'next/server'
import { transitionAssignment } from '@/lib/operational-tasks'
import { prisma } from '@/lib/prisma'
import { queueOperationalTaskStatusToAdmin } from '@/lib/operational-task-telegram'
import { withApiRoute, apiDataSuccess, apiFailure, requireJwt, guardViewerWrite, parseJsonBody } from '@/lib/core/safe-route-helpers'

export const dynamic = 'force-dynamic'

export const PATCH = withApiRoute('operational_tasks.assignment', async (req: NextRequest, routeCtx?: unknown) => {
  const { params } = (routeCtx ?? {}) as { params: { assignmentId: string } }
  const write = await guardViewerWrite(req)
  if (!write.ok) return write.response
  const auth = await requireJwt(req)
  if (!auth.ok) return auth.response

  const body = await parseJsonBody<{ action?: 'acknowledge' | 'start' | 'complete' | 'dismiss' }>(req)
  const action = body.action
  if (!action) return apiFailure('invalid_request', 'action required', { status: 400 })

  const assignmentId = params.assignmentId
  const owned = await prisma.operationalTaskAssignment.findFirst({
    where: { id: assignmentId, userId: auth.token.sub },
    select: { id: true },
  })
  if (!owned) return apiFailure('forbidden', 'Forbidden', { status: 403 })

  const result = await transitionAssignment(assignmentId, String(auth.token.sub), action)
  if ('error' in result && result.error) {
    return apiFailure('transition_failed', result.error, { status: result.status })
  }

  if (result.assignment && (action === 'acknowledge' || action === 'complete')) {
    const row = await prisma.operationalTaskAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        task: { select: { title: true, businessId: true, createdById: true } },
        user: { select: { name: true, email: true } },
      },
    })
    if (row) {
      queueOperationalTaskStatusToAdmin({
        businessId: row.task.businessId,
        assignmentId,
        title: row.task.title,
        assigneeName: row.user.name || row.user.email || 'Employee',
        action: action === 'complete' ? 'COMPLETED' : 'ACKNOWLEDGED',
      })
    }
  }

  return apiDataSuccess({ assignment: result.assignment })
})
