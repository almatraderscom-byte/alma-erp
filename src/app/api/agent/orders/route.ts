import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import {
  AgentOrdersListSchema,
  ListOrdersQuerySchema,
} from '@/lib/agent-api/orders.schema'
import { isoToYmd } from '@/lib/agent-api/period'
import { listAgentOrders } from '@/lib/agent-api/orders.service'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied

  const raw = Object.fromEntries(req.nextUrl.searchParams.entries())
  const parsed = ListOrdersQuerySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid query', details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const { status, limit, from, to } = parsed.data
  let startDate: string | undefined
  let endDate: string | undefined
  if (from) startDate = isoToYmd(from)
  if (to) {
    const end = isoToYmd(to)
    endDate = end
  }

  try {
    const result = await listAgentOrders({
      status,
      limit,
      startDate,
      endDate,
      fromIso: from ?? null,
      toIso: to ?? null,
    })
    const payload = AgentOrdersListSchema.parse(result)
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'private, no-store, must-revalidate' },
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to fetch orders' },
      { status: 500 },
    )
  }
}
