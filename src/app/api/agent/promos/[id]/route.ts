import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import { PatchPromoBodySchema } from '@/lib/agent-api/schemas/promos.schema'
import * as svc from '@/lib/agent-api/services/promos.service'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = PatchPromoBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'promo.updated', params.id, body.data, () => svc.patchPromo(params.id, body.data))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  try {
    const result = await agentWrite(req, 'promo.deleted', params.id, {}, () => svc.deletePromo(params.id))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
