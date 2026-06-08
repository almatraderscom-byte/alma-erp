import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import { PatchCustomerBodySchema } from '@/lib/agent-api/schemas/customers.schema'
import * as svc from '@/lib/agent-api/services/customers.service'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(_req)
  if (denied) return denied
  const data = await svc.getCustomer(params.id)
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ data })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = PatchCustomerBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'customer.updated', params.id, body.data, () => svc.patchCustomer(params.id, body.data))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
