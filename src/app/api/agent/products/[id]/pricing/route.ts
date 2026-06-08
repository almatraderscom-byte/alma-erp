import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import { PatchProductPricingBodySchema } from '@/lib/agent-api/schemas/products.schema'
import * as svc from '@/lib/agent-api/services/products.service'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = PatchProductPricingBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'product.pricing_updated', params.id, body.data, () => svc.patchProductPricing(params.id, body.data.price, body.data.note))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
