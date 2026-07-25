/**
 * GET /api/assistant/phone-console/quality — audio quality per day, and the worst calls.
 *
 * Owner-only and read-only. The point of this endpoint is that an audio regression should be
 * caught by a number that moved rather than by the owner noticing a call sounded wrong.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { periodDays, qualityReport } from '@/agent/lib/phone-console'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 })
  if (!isSystemOwner(session)) return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 })

  const days = periodDays(new URL(req.url).searchParams.get('period'))
  try {
    const report = await qualityReport(days)
    return NextResponse.json({ ok: true, ...report, days })
  } catch (err) {
    console.warn('[phone-console/quality] failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: false, error: 'query_failed' }, { status: 500 })
  }
}
