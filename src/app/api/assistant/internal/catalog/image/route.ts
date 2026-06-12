import { type NextRequest } from 'next/server'
import { internalAuthHeaders } from '@/agent/lib/catalog/internal-auth'
import { addProductImage } from '@/agent/lib/catalog/product-images'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const denied = internalAuthHeaders(req.headers.get('authorization'))
  if (denied) return denied

  let body: { productCode?: string; imageBase64?: string; uploadedByChatId?: string; business?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const { productCode, imageBase64, uploadedByChatId, business } = body
  if (!productCode || !imageBase64) {
    return Response.json({ error: 'productCode and imageBase64 required' }, { status: 400 })
  }

  const imageBuffer = Buffer.from(imageBase64, 'base64')
  const result = await addProductImage({ productCode, imageBuffer, uploadedByChatId, business })
  if (!result.ok) {
    return Response.json(result, { status: 400 })
  }
  return Response.json(result)
}
