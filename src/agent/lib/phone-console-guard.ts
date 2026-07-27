/**
 * Owner-only gate for the phone console's API routes.
 *
 * Every other route under `/api/assistant/*` is open to any signed-in staff member. These
 * are not: who called which number is customer data, and from step 2 onward these routes
 * CHANGE how a live business line behaves. The section's page layout enforces the same rule
 * for the screens, but a route that trusted the page would be open to anyone with a URL.
 *
 * Returns a response to send back, or the owner's identity for the audit trail.
 */
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { requireAgentEnabled } from '@/agent/lib/guards'

export async function requireConsoleOwner(): Promise<
  { ok: true; actor: string } | { ok: false; response: Response }
> {
  const disabled = requireAgentEnabled()
  if (disabled) return { ok: false, response: disabled }

  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return { ok: false, response: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) }
  }
  if (!isSystemOwner(session)) {
    return { ok: false, response: NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }) }
  }

  const user = session.user as { email?: string | null; name?: string | null }
  return { ok: true, actor: user.email || user.name || 'owner' }
}
