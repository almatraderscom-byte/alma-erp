/**
 * End a live office call — POST /api/assistant/office/intercom/end
 *   { broadcastId: string, reason: 'cancelled'|'declined'|'missed'|'completed' }
 *
 * Either participant (caller or callee) may end. First writer wins; a "cancel"
 * wake push then stops the other side's ring instantly (WhatsApp-style), and the
 * call row is left as the missed-/completed-call history the feed renders.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { resolveSessionStaff } from '@/agent/lib/office-staff'
import { endCall, type CallEndReason } from '@/agent/lib/office-intercom'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const DEFAULT_BUSINESS = 'ALMA_LIFESTYLE'
const REASONS: CallEndReason[] = ['cancelled', 'declined', 'missed', 'completed']

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let businessId: string
  if (isSystemOwner(token)) {
    businessId = req.nextUrl.searchParams.get('businessId')?.trim() || DEFAULT_BUSINESS
  } else {
    const staff = await resolveSessionStaff(token.sub)
    if (!staff) return Response.json({ error: 'forbidden' }, { status: 403 })
    businessId = staff.businessId
  }

  let body: { broadcastId?: string; reason?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const broadcastId = body.broadcastId?.trim()
  if (!broadcastId) return Response.json({ error: 'broadcast_required' }, { status: 400 })
  const reason = (REASONS.includes(body.reason as CallEndReason) ? body.reason : 'completed') as CallEndReason

  const res = await endCall({ broadcastId, businessId, reason, actorUserId: token.sub })
  return Response.json(res, { status: 200 })
}
