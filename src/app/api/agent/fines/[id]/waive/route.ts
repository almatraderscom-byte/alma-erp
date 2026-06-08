import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import { WaiveFineBodySchema } from '@/lib/agent-api/schemas/fines.schema'
import * as svc from '@/lib/agent-api/services/fines.service'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = WaiveFineBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'fine.waived', params.id, body.data, () => svc.waiveFine(params.id, body.data.reason))
    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
