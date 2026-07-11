/**
 * POST /api/assistant/office/intercom/receipt
 * Staff advances their own receipt on a broadcast:
 *   { broadcastId, action: 'played' | 'confirmed' }
 * 'played'   — audio started on their phone (auto-fired by the takeover)
 * 'confirmed' — they tapped "শুনেছি — কনফার্ম"
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { resolveSessionStaff } from '@/agent/lib/office-staff'
import { markIntercomReceipt } from '@/agent/lib/office-intercom'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const staff = await resolveSessionStaff(token.sub)
  if (!staff) return Response.json({ error: 'staff_only' }, { status: 403 })

  let body: { broadcastId?: string; action?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const broadcastId = body.broadcastId?.trim()
  const action = body.action
  if (!broadcastId || (action !== 'played' && action !== 'confirmed')) {
    return Response.json({ error: 'invalid_args' }, { status: 400 })
  }

  const changed = await markIntercomReceipt({ broadcastId, staffId: staff.id, action })
  return Response.json({ ok: true, changed })
}
