import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { AgentOrderDetailSchema } from '@/lib/agent-api/orders.schema'
import { getAgentOrderDetail } from '@/lib/agent-api/orders.service'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const denied = guardAgentRequest(req)
  if (denied) return denied

  const id = params.id?.trim()
  if (!id) {
    return NextResponse.json({ error: 'Order id required' }, { status: 400 })
  }

  try {
    const order = await getAgentOrderDetail(id)
    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }
    const payload = AgentOrderDetailSchema.parse(order)
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'private, no-store, must-revalidate' },
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to fetch order' },
      { status: 500 },
    )
  }
}
