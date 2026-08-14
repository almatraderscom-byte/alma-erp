import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { resendSpotlight } from '@/lib/operational-tasks'
import { withApiRoute, apiDataSuccess, apiFailure, requireJwtRoles, guardViewerWrite, parseJsonBody, routeParams } from '@/lib/core/safe-route-helpers'

export const dynamic = 'force-dynamic'

export const PATCH = withApiRoute('operational_tasks.update', async (req: NextRequest, routeCtx?: unknown) => {
  const taskId = (await routeParams<{ id: string }>(routeCtx)).id ?? ''
  if (!taskId) return apiFailure('task_id_required', 'Task id missing from the request URL.', { status: 400 })
  const write = await guardViewerWrite(req)
  if (!write.ok) return write.response
  const auth = await requireJwtRoles(req, ['SUPER_ADMIN'])
  if (!auth.ok) return auth.response

  const body = await parseJsonBody<{
    action?: 'archive' | 'resend'
    assignment_id?: string
    title?: string
    description?: string
    priority?: string
    banner_image_url?: string | null
    deadline?: string | null
    acknowledgment_required?: boolean
    allow_dismiss?: boolean
    show_on_check_in?: boolean
  }>(req)

  if (body.action === 'archive') {
    await prisma.operationalTask.update({
      where: { id: taskId },
      data: { status: 'ARCHIVED' },
    })
    await prisma.operationalTaskAssignment.updateMany({
      where: { taskId: taskId, status: { not: 'COMPLETED' } },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    })
    return apiDataSuccess({ archived: true })
  }

  if (body.action === 'resend' && body.assignment_id) {
    await resendSpotlight(body.assignment_id)
    return apiDataSuccess({ resent: true })
  }

  const data: Record<string, unknown> = {}
  if (body.title) data.title = String(body.title).trim()
  if (body.description) data.description = String(body.description).trim()
  if (body.priority) data.priority = body.priority
  if (body.banner_image_url !== undefined) data.bannerImageUrl = body.banner_image_url
  if (body.deadline !== undefined) data.deadline = body.deadline ? new Date(body.deadline) : null
  if (body.acknowledgment_required !== undefined) data.acknowledgmentRequired = body.acknowledgment_required
  if (body.allow_dismiss !== undefined) data.allowDismiss = body.allow_dismiss
  if (body.show_on_check_in !== undefined) data.showOnCheckIn = body.show_on_check_in

  if (Object.keys(data).length) {
    await prisma.operationalTask.update({ where: { id: taskId }, data })
  }
  return apiDataSuccess({ updated: true })
})

export const DELETE = withApiRoute('operational_tasks.delete', async (req: NextRequest, routeCtx?: unknown) => {
  const taskId = (await routeParams<{ id: string }>(routeCtx)).id ?? ''
  if (!taskId) return apiFailure('task_id_required', 'Task id missing from the request URL.', { status: 400 })
  const auth = await requireJwtRoles(req, ['SUPER_ADMIN'])
  if (!auth.ok) return auth.response

  await prisma.operationalTask.update({
    where: { id: taskId },
    data: { status: 'ARCHIVED' },
  })
  return apiDataSuccess({ archived: true })
})
