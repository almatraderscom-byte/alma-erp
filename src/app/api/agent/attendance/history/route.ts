import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import { AttendanceHistoryQuerySchema } from '@/lib/agent-api/schemas/attendance.schema'
import * as svc from '@/lib/agent-api/services/attendance.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const parsed = AttendanceHistoryQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const data = await svc.getAttendanceHistory(parsed.data.employee_id, parsed.data.days)
  return NextResponse.json({ data })
}
