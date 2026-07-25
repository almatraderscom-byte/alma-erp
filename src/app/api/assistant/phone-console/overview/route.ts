/**
 * GET /api/assistant/phone-console/overview — the line, right now, plus today's tally.
 *
 * Owner-only and read-only. Every other route under /api/assistant/* is open to any signed-in
 * staff member; this one is not, because "who is on a call with which number" is customer
 * data and the registration/cap detail is infrastructure the owner alone operates.
 */
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { fetchLine, todayTally } from '@/agent/lib/phone-console'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 })
  if (!isSystemOwner(session)) return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 })

  // The gateway being unreachable must not also cost the owner today's numbers — they come
  // from our own database and are still true when the VPS is not answering.
  const [line, today] = await Promise.all([
    fetchLine(),
    todayTally().catch(() => null),
  ])

  return NextResponse.json({ ok: true, line, today, fetchedAt: new Date().toISOString() })
}
