/**
 * GET /api/assistant/office/thread?taskId=...
 * Comment thread + timeline for one task. Visible to the owner, or to the
 * staff member the task belongs to.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getTaskThread } from '@/agent/lib/office-hub'
import { resolveSessionStaff } from '@/agent/lib/office-staff'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_BUSINESS = 'ALMA_LIFESTYLE'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const taskId = req.nextUrl.searchParams.get('taskId')?.trim()
  if (!taskId) return Response.json({ error: 'taskId required' }, { status: 400 })

  const owner = isSystemOwner(token)
  const staff = owner ? null : await resolveSessionStaff(token.sub)
  if (!owner && !staff) return Response.json({ error: 'forbidden' }, { status: 403 })

  const businessId = owner
    ? req.nextUrl.searchParams.get('businessId')?.trim() || DEFAULT_BUSINESS
    : staff!.businessId

  const thread = await getTaskThread(taskId, businessId)
  if (!thread.task) return Response.json({ error: 'task_not_found' }, { status: 404 })
  // Staff may only read their own task's thread.
  if (!owner && thread.task.staffId !== staff!.id) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  return Response.json(thread)
}
