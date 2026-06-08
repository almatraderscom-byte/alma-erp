import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import { AuditByActionQuerySchema } from '@/lib/agent-api/schemas/reports.schema'
import * as svc from '@/lib/agent-api/services/audit.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const parsed = AuditByActionQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const data = await svc.listRecentAudits(parsed.data.limit, parsed.data.action)
  return NextResponse.json({ data: { entries: data, meta: { count: data.length, action: parsed.data.action } } })
}
