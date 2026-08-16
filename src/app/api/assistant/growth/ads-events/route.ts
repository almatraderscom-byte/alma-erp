/**
 * Meta Ads event inbox — list. Owner-only read of the stored webhook events
 * (recommendations, creative fatigue, delivery-status changes) that used to be
 * push-only and unrecoverable.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { listAdsEvents } from '@/agent/lib/marketing/ads-events'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const statusParam = req.nextUrl.searchParams.get('status') ?? 'open'
  const status = ['open', 'all', 'new', 'seen', 'actioned', 'dismissed'].includes(statusParam)
    ? (statusParam as 'open' | 'all' | 'new' | 'seen' | 'actioned' | 'dismissed')
    : 'open'
  const limit = Number(req.nextUrl.searchParams.get('limit') ?? 20)

  try {
    const events = await listAdsEvents({ status, limit })
    return Response.json({ events })
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'ads events পড়া যায়নি' },
      { status: 500 },
    )
  }
}
