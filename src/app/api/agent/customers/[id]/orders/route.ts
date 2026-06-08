import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import * as svc from '@/lib/agent-api/services/customers.service'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(_req)
  if (denied) return denied
  const data = await svc.getCustomerOrders(params.id)
  return NextResponse.json({ data })
}
