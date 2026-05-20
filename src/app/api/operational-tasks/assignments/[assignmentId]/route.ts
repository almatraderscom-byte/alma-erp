import { NextRequest, NextResponse } from 'next/server'
import { getJwt, forbidViewerWrite } from '@/lib/api-guards'
import { transitionAssignment } from '@/lib/operational-tasks'
import { prisma } from '@/lib/prisma'
import { queueOperationalTaskStatusToAdmin } from '@/lib/operational-task-telegram'

export const dynamic = 'force-dynamic'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { assignmentId: string } },
) {
  const denied = await forbidViewerWrite(req)
  if (denied) return denied
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as {
    action?: 'acknowledge' | 'start' | 'complete' | 'dismiss'
  }
  const action = body.action
  if (!action) return NextResponse.json({ error: 'action required' }, { status: 400 })

  const assignmentId = params.assignmentId
  const owned = await prisma.operationalTaskAssignment.findFirst({
    where: { id: assignmentId, userId: token.sub },
    select: { id: true },
  })
  if (!owned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const result = await transitionAssignment(assignmentId, token.sub, action)
  if ('error' in result && result.error) {
    return NextResponse.json({ error: result.error }, { status: result.status })
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

  return NextResponse.json({ assignment: result.assignment })
}
