import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import { ReportsCustomersQuerySchema } from '@/lib/agent-api/schemas/reports.schema'
import * as svc from '@/lib/agent-api/services/reports.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const parsed = ReportsCustomersQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const { period, top } = parsed.data
  const data = await svc.reportCustomers(period, top)
  return NextResponse.json({ data })
}
