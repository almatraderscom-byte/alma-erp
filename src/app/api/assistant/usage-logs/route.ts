/**
 * GET /api/assistant/usage-logs — range-filtered spend-event log (owner only).
 *
 * Query params:
 *   from=ISO&to=ISO   time window (defaults: to=now, from=now-1h — owner rule:
 *                     the native Logs page opens on "Past 1 hour", never huge)
 *   limit=100         page size (1..200)
 *   cursor=<opaque>   from a previous response's nextCursor (keyset pagination)
 *
 * First page also returns `buckets` (calls-per-bucket histogram over the whole
 * window), `totalCalls` and `totalCostUsd` — computed by one indexed aggregate
 * so the mini-chart stays exact while rows paginate. Auth mirrors
 * /api/assistant/live-pulse: requireAgentEnabled + session token + system owner.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getUsageLogs } from '@/agent/lib/usage-logs'
import { captureAgentError } from '@/agent/lib/sentry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Widest allowed window — keeps the range scan on the occurred_at index sane. */
const MAX_SPAN_MS = 92 * 86_400_000
const DEFAULT_SPAN_MS = 3_600_000 // 1 hour

function parseIso(value: string | null): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  try {
    const params = req.nextUrl.searchParams
    const to = parseIso(params.get('to')) ?? new Date()
    const from = parseIso(params.get('from')) ?? new Date(to.getTime() - DEFAULT_SPAN_MS)
    if (from.getTime() >= to.getTime()) {
      return Response.json({ error: 'bad_range', message: 'from must be before to' }, { status: 400 })
    }
    if (to.getTime() - from.getTime() > MAX_SPAN_MS) {
      return Response.json({ error: 'range_too_wide', message: 'max window is 92 days' }, { status: 400 })
    }

    const limitParam = parseInt(params.get('limit') ?? '100', 10)
    const limit = Number.isFinite(limitParam) ? limitParam : 100

    const pageData = await getUsageLogs({ from, to, limit, cursor: params.get('cursor') })
    return Response.json(pageData)
  } catch (err) {
    console.error('[assistant/usage-logs GET]', err)
    void captureAgentError(err, 'costs.usage_logs_get_failed', { route: 'usage-logs' })
    return Response.json({
      error: 'server_error',
      message: err instanceof Error ? err.message : 'Usage logs load failed',
    }, { status: 500 })
  }
}
