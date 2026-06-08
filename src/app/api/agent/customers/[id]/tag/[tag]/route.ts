import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import * as svc from '@/lib/agent-api/services/customers.service'

export async function DELETE(req: NextRequest, { params }: { params: { id: string; tag: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  try {
    const result = await agentWrite(req, 'customer.tag_removed', params.id, { tag: params.tag }, () => svc.removeCustomerTag(params.id, decodeURIComponent(params.tag)))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
