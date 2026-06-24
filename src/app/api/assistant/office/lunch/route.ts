/**
 * POST /api/assistant/office/lunch
 * Logged-in staff start / end their lunch break (45-min allowance).
 *
 * The >45 / ≥60-min overrun alerts (to staff + owner) are owned by the VPS
 * worker cron (`lunch-watch`) — this route only opens/closes the StaffLunch row.
 *
 * Body: { action: 'start' | 'end' }
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { resolveSessionStaff, staffStartLunch, staffEndLunch } from '@/agent/lib/office-staff'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const staff = await resolveSessionStaff(token.sub)
  if (!staff) return Response.json({ error: 'not_staff' }, { status: 403 })

  let body: { action?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const action = body.action?.trim()
  if (action === 'start') {
    const r = await staffStartLunch(staff)
    return r.ok ? Response.json({ ok: true, status: r.status, startedAt: r.startedAt }) : Response.json({ error: r.error }, { status: r.code })
  }
  if (action === 'end') {
    const r = await staffEndLunch(staff)
    return r.ok ? Response.json({ ok: true, status: r.status, durationMin: r.durationMin }) : Response.json({ error: r.error }, { status: r.code })
  }
  return Response.json({ error: 'unknown_action' }, { status: 400 })
}
