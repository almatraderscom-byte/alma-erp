import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Feed for the iOS App Intents entity cache (Phase N3). Returns the owner's recent
 * ALMA Lifestyle orders as lightweight rows the native EntityCacheBridge persists to
 * the shared App Group, so Siri / Spotlight / Shortcuts can surface them as
 * `OrderEntity`s. Owner-only (same auth as /api/assistant/live-pulse).
 *
 * PRIVACY: entities can surface on-device in Spotlight, so we expose NO money —
 * only id, a customer+product title, and status. Cheap query: newest N over the
 * indexed businessId/createdAt window.
 *
 * `products` is returned as an empty array for now — there is no separate product
 * catalog to enumerate; ProductEntity stays wired but unpopulated until a product
 * source exists.
 */

const MAX_ENTITIES = 20

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const orders = await prisma.lifestyleOrder.findMany({
    where: { businessId: 'ALMA_LIFESTYLE' },
    orderBy: { createdAt: 'desc' },
    take: MAX_ENTITIES,
    select: { id: true, customer: true, product: true, status: true },
  })

  const rows = orders.map((o) => ({
    id: o.id,
    title: [o.customer, o.product].filter(Boolean).join(' — ') || o.id,
    status: o.status || '',
  }))

  return Response.json({ orders: rows, products: [] })
}
