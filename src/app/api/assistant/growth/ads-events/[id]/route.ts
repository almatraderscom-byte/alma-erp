/**
 * One Meta Ads event: GET resolves + caches the Graph detail behind Meta's stub
 * message; POST records the owner's decision (seen / actioned / dismissed) so a
 * handled recommendation stops re-pushing forever.
 *
 * Next 16: `params` is a Promise — read it via routeParams(), never off ctx.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { routeParams } from '@/lib/core/safe-api'
import { isSystemOwner } from '@/lib/roles'
import {
  getAdsEvent,
  resolveAdsEventDetail,
  setAdsEventStatus,
  type AdsEventStatus,
} from '@/agent/lib/marketing/ads-events'

export const runtime = 'nodejs'

const ALLOWED_STATUSES: AdsEventStatus[] = ['new', 'seen', 'actioned', 'dismissed']

async function guard(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

export async function GET(req: NextRequest, ctx: unknown) {
  const blocked = await guard(req)
  if (blocked) return blocked

  const { id } = await routeParams<{ id: string }>(ctx)
  if (!id) return Response.json({ error: 'id দরকার' }, { status: 400 })

  const force = req.nextUrl.searchParams.get('refresh') === '1'
  try {
    const event = await resolveAdsEventDetail(id, { force })
    if (!event) return Response.json({ error: 'not_found' }, { status: 404 })
    return Response.json({ event })
  } catch (err) {
    // Detail resolution is best-effort — still hand back the stored row.
    const fallback = await getAdsEvent(id).catch(() => null)
    if (fallback) return Response.json({ event: fallback, detailError: String(err) })
    return Response.json({ error: err instanceof Error ? err.message : 'পড়া যায়নি' }, { status: 500 })
  }
}

export async function POST(req: NextRequest, ctx: unknown) {
  const blocked = await guard(req)
  if (blocked) return blocked

  const { id } = await routeParams<{ id: string }>(ctx)
  if (!id) return Response.json({ error: 'id দরকার' }, { status: 400 })

  let body: { status?: string; note?: string }
  try {
    body = (await req.json()) as { status?: string; note?: string }
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const status = String(body.status ?? '') as AdsEventStatus
  if (!ALLOWED_STATUSES.includes(status)) {
    return Response.json({ error: `status একটি হতে হবে: ${ALLOWED_STATUSES.join(', ')}` }, { status: 400 })
  }

  try {
    const event = await setAdsEventStatus(id, status, body.note ?? null)
    if (!event) return Response.json({ error: 'not_found' }, { status: 404 })
    return Response.json({ event })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'আপডেট হয়নি' }, { status: 500 })
  }
}
