/**
 * GET /api/assistant/phone-console/overview — the line right now, plus the period's numbers.
 *
 * Owner-only and read-only. Every other route under /api/assistant/* is open to any signed-in
 * staff member; this one is not, because "who is on a call with which number" is customer
 * data and the registration/cap detail is infrastructure the owner alone operates.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { fetchLine, periodDays, tally } from '@/agent/lib/phone-console'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 })
  if (!isSystemOwner(session)) return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 })

  const url = new URL(req.url)
  const days = periodDays(url.searchParams.get('period'))
  // The live panel polls every few seconds and only needs the gateway; skipping the tally
  // there keeps a 90-day aggregate from being recomputed on every tick.
  const lineOnly = url.searchParams.get('lineOnly') === '1'

  // The gateway being unreachable must not also cost the owner his numbers — those come from
  // our own database and are still true when the VPS is not answering.
  const [line, stats] = await Promise.all([
    fetchLine(),
    lineOnly ? Promise.resolve(null) : tally(days).catch(() => null),
  ])

  return NextResponse.json({
    ok: true,
    line,
    tally: stats?.tally ?? null,
    trend: stats?.trend ?? [],
    fetchedAt: new Date().toISOString(),
  })
}
