import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import { CustomerNoteBodySchema } from '@/lib/agent-api/schemas/customers.schema'
import * as svc from '@/lib/agent-api/services/customers.service'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = CustomerNoteBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'customer.note_added', params.id, body.data, () => svc.addCustomerNote(params.id, body.data.note))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
