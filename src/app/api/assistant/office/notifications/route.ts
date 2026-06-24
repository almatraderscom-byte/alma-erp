/**
 * GET  /api/assistant/office/notifications  → feed + unread count
 * POST /api/assistant/office/notifications  → mark read ({ id? } — omit to mark all)
 *
 * Scope is derived from the session: owner gets the owner bucket, staff get
 * their own. Both buckets are scoped to the viewer's business.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { resolveSessionStaff } from '@/agent/lib/office-staff'
import {
  getNotificationFeed,
  markNotificationsRead,
  type NotifScope,
} from '@/agent/lib/office-notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_BUSINESS = 'ALMA_LIFESTYLE'

async function resolveScope(
  req: NextRequest,
): Promise<{ scope: NotifScope; businessId: string } | { error: string; code: number }> {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return { error: 'unauthorized', code: 401 }

  if (isSystemOwner(token)) {
    const businessId = req.nextUrl.searchParams.get('businessId')?.trim() || DEFAULT_BUSINESS
    return { scope: { owner: true }, businessId }
  }

  const staff = await resolveSessionStaff(token.sub)
  if (!staff) return { error: 'forbidden', code: 403 }
  return { scope: { owner: false, staffId: staff.id }, businessId: staff.businessId }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const resolved = await resolveScope(req)
  if ('error' in resolved) return Response.json({ error: resolved.error }, { status: resolved.code })

  const feed = await getNotificationFeed(resolved.scope, resolved.businessId)
  return Response.json(feed)
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const resolved = await resolveScope(req)
  if ('error' in resolved) return Response.json({ error: resolved.error }, { status: resolved.code })

  let body: { id?: string } = {}
  try {
    body = await req.json()
  } catch {
    // empty body → mark all
  }

  const count = await markNotificationsRead(resolved.scope, resolved.businessId, body.id?.trim() || undefined)
  return Response.json({ ok: true, marked: count })
}
