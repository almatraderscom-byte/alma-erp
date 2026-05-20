import { NextRequest, NextResponse } from 'next/server'
import { getJwt, forbidViewerWrite } from '@/lib/api-guards'
import { normalizeAlmaRole } from '@/lib/roles'
import { createOperationalTask, listTasksForAdmin } from '@/lib/operational-tasks'
import { prisma } from '@/lib/prisma'
import { queueOperationalTaskAssigned } from '@/lib/operational-task-telegram'
import type { OperationalTaskPriority } from '@prisma/client'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (normalizeAlmaRole(token.role as string) !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const businessId = new URL(req.url).searchParams.get('business_id')
  const tasks = await listTasksForAdmin(businessId)
  return NextResponse.json({ tasks })
}

export async function POST(req: NextRequest) {
  const denied = await forbidViewerWrite(req)
  if (denied) return denied
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (normalizeAlmaRole(token.role as string) !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as {
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
  }

  const title = String(body.title || '').trim()
  const description = String(body.description || '').trim()
  const assigneeUserIds = Array.isArray(body.assignee_user_ids)
    ? [...new Set(body.assignee_user_ids.filter(Boolean))]
    : []

  if (!title || !description) {
    return NextResponse.json({ error: 'Title and description are required.' }, { status: 400 })
  }
  if (!assigneeUserIds.length) {
    return NextResponse.json({ error: 'Select at least one employee.' }, { status: 400 })
  }

  const task = await createOperationalTask(token.sub, {
    title,
    description,
    priority: body.priority,
    bannerImageUrl: body.banner_image_url,
    deadline: body.deadline,
    acknowledgmentRequired: body.acknowledgment_required,
    allowDismiss: body.allow_dismiss,
    showOnCheckIn: body.show_on_check_in,
    businessId: body.business_id,
    assigneeUserIds,
  })

  const users = await prisma.user.findMany({
    where: { id: { in: assigneeUserIds } },
    select: { id: true, name: true, email: true },
  })
  const nameById = new Map(users.map(u => [u.id, u.name || u.email]))

  for (const a of task.assignments) {
    queueOperationalTaskAssigned({
      businessId: task.businessId,
      assignmentId: a.id,
      userId: a.userId,
      title: task.title,
      priority: task.priority,
      deadline: task.deadline,
      assigneeName: nameById.get(a.userId) || 'Employee',
    })
  }

  return NextResponse.json({ ok: true, taskId: task.id })
}
