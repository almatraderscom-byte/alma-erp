import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import * as svc from '@/lib/agent-api/services/inventory.service'

export async function GET(_req: NextRequest, props: { params: Promise<{ product_id: string }> }) {
  const params = await props.params;
  const denied = guardAgentRequest(_req)
  if (denied) return denied
  const data = await svc.getInventoryProduct(params.product_id)
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ data })
}
