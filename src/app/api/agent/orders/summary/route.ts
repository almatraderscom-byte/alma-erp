import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import {
  AgentOrdersSummarySchema,
  SummaryPeriodSchema,
} from '@/lib/agent-api/orders.schema'
import { getAgentOrdersSummary } from '@/lib/agent-api/orders.service'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied

  const periodParam = req.nextUrl.searchParams.get('period') ?? 'today'
  const parsed = SummaryPeriodSchema.safeParse(periodParam)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid period' }, { status: 400 })
  }

  try {
    const summary = await getAgentOrdersSummary(parsed.data)
    const payload = AgentOrdersSummarySchema.parse(summary)
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'private, no-store, must-revalidate' },
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to fetch summary' },
      { status: 500 },
    )
  }
}
