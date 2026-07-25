/**
 * GET /api/assistant/phone-console/calls — the call log, filtered.
 *
 * Owner-only and read-only: history, hangup causes, audio counters and a freshly signed
 * recording link per call. The stored recording URL is signed and expires, so it is re-signed
 * here rather than handed over dead.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { listCalls, type CallLogFilters } from '@/agent/lib/phone-console'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 })
  if (!isSystemOwner(session)) return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 })

  const q = new URL(req.url).searchParams
  const direction = q.get('direction')
  const status = q.get('status')
  const filters: CallLogFilters = {
    days: Number(q.get('days') ?? 7) || 7,
    limit: Number(q.get('limit') ?? 50) || 50,
    direction: direction === 'inbound' || direction === 'outbound' ? direction : 'all',
    status: status === 'answered' || status === 'unreached' || status === 'recorded' ? status : 'all',
    number: q.get('number') ?? undefined,
  }

  try {
    const calls = await listCalls(filters)
    return NextResponse.json({ ok: true, calls, filters })
  } catch (err) {
    console.warn('[phone-console/calls] failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: false, error: 'query_failed' }, { status: 500 })
  }
}
