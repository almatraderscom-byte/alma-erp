import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { isSystemOwner } from '@/lib/roles'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { markOwnerAppActive } from '@/agent/lib/owner-presence'

export const runtime = 'nodejs'

/**
 * Owner app heartbeat. The agent app POSTs here every ~20s while it is in the
 * foreground; we stamp the last-active time so agent push (ntfy) is suppressed
 * while the owner is actually looking at the app, and only fires when away.
 */
export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub || !isSystemOwner(token)) {
    return Response.json({ ok: false }, { status: 401 })
  }

  try {
    await markOwnerAppActive()
  } catch {
    // Presence is best-effort — a write glitch just means a push may fire while
    // in-app; never error the heartbeat.
  }
  return Response.json({ ok: true })
}
