import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import { OrderRefundBodySchema } from '@/lib/agent-api/schemas/reports.schema'
import * as svc from '@/lib/agent-api/services/orders-write.service'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = OrderRefundBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'order.refunded', params.id, body.data, () => svc.refundOrder(params.id, body.data))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
