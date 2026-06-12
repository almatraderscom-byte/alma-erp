import { type NextRequest } from 'next/server'
import { internalAuthHeaders } from '@/agent/lib/catalog/internal-auth'
import { catalogStatus } from '@/agent/lib/catalog/product-images'
import { DEFAULT_CATALOG_BUSINESS } from '@/agent/lib/catalog/inventory-lookup'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const denied = internalAuthHeaders(req.headers.get('authorization'))
  if (denied) return denied

  const business = req.nextUrl.searchParams.get('business') ?? DEFAULT_CATALOG_BUSINESS
  const status = await catalogStatus(business)
  return Response.json(status)
}
