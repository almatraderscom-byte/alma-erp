import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import { CreatePromoBodySchema } from '@/lib/agent-api/schemas/promos.schema'
import * as svc from '@/lib/agent-api/services/promos.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const data = await svc.listPromos()
  return NextResponse.json({ data })
}

export async function POST(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = CreatePromoBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'promo.created', null, body.data, () => svc.createPromo(body.data))
    return NextResponse.json(result, { status: 201 })
  } catch (e) { return agentErrorResponse(e) }
}
