import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import { ApproveFineBodySchema } from '@/lib/agent-api/schemas/fines.schema'
import * as svc from '@/lib/agent-api/services/fines.service'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = ApproveFineBodySchema.safeParse(await req.json().catch(() => ({ approvedBy: 'agent_via_sir' })))
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'fine.approved', params.id, body.data, () => svc.approveFine(params.id, body.data.note))
    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
