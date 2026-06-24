import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { canManageCatalogImages } from '@/lib/roles'
import { listCatalogForImages } from '@/agent/lib/catalog/product-images'
import { DEFAULT_CATALOG_BUSINESS } from '@/agent/lib/catalog/inventory-lookup'

export const runtime = 'nodejs'
export const maxDuration = 30

/**
 * Owner/CS-facing catalog listing for the product-image screen.
 * Returns family-matching sets collapsed into ONE card each, plain products
 * as their own card, with image counts and a primary thumbnail.
 */
export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!canManageCatalogImages(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const business = req.nextUrl.searchParams.get('business') || DEFAULT_CATALOG_BUSINESS
  try {
    const data = await listCatalogForImages(business)
    return Response.json({ ok: true, business, ...data })
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown'
    console.error('[assistant/catalog/products] failed:', detail)
    return Response.json({ ok: false, error: 'catalog_unavailable', detail }, { status: 502 })
  }
}
