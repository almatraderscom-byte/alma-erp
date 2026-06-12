import { type NextRequest } from 'next/server'
import { internalAuthHeaders } from '@/agent/lib/catalog/internal-auth'
import { deleteImagesForCode } from '@/agent/lib/catalog/product-images'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const denied = internalAuthHeaders(req.headers.get('authorization'))
  if (denied) return denied

  let body: { productCode?: string; business?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (!body.productCode) {
    return Response.json({ error: 'productCode required' }, { status: 400 })
  }

  const result = await deleteImagesForCode(body.productCode, body.business)
  return Response.json(result)
}
