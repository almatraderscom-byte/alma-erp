import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import { ListProductsQuerySchema, CreateProductBodySchema } from '@/lib/agent-api/schemas/products.schema'
import * as svc from '@/lib/agent-api/services/products.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const parsed = ListProductsQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const data = await svc.listProducts(parsed.data)
  return NextResponse.json({ data })
}

export async function POST(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = CreateProductBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'product.created', null, body.data, () => svc.createProduct(body.data))
    return NextResponse.json(result, { status: 201 })
  } catch (e) { return agentErrorResponse(e) }
}
