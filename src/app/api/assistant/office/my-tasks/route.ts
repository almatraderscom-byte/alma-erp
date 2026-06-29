/**
 * GET /api/assistant/office/my-tasks → the logged-in staff's still-open tasks for
 * today, in serial order. Powers the "আজকের কাজ" picker in the office group chat.
 * Owner has no personal task list here, so they get an empty list.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { resolveSessionStaff, listStaffTodayTasks } from '@/agent/lib/office-staff'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const staff = await resolveSessionStaff(token.sub)
  if (!staff) return Response.json({ tasks: [] })

  const tasks = await listStaffTodayTasks(staff)
  return Response.json({ tasks })
}
