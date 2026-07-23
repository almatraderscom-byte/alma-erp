import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { isSystemOwner } from '@/lib/roles'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { markOwnerAppPresence, type OwnerAppPresenceState } from '@/agent/lib/owner-presence'

export const runtime = 'nodejs'

/**
 * Owner app lifecycle + heartbeat. Foreground clients refresh `active` every
 * ~20s; background clients write `background` immediately.
 */
export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub || !isSystemOwner(token)) {
    return Response.json({ ok: false }, { status: 401 })
  }

  let state: OwnerAppPresenceState = 'active'
  try {
    const body = await req.json() as { state?: unknown }
    if (body.state === 'background') state = 'background'
    else if (body.state != null && body.state !== 'active') {
      return Response.json({ error: 'invalid_state' }, { status: 400 })
    }
  } catch {
    // Older clients sent an empty body. Treat that as the legacy active ping.
  }

  try {
    await markOwnerAppPresence(state)
  } catch {
    // Presence is best-effort — a write glitch just means a push may fire while
    // in-app; never error the heartbeat.
  }
  return Response.json({ ok: true, state })
}
