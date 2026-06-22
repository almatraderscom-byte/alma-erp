/**
 * GET /api/assistant/costs/logs            — recent spend events across all APIs (owner)
 * GET /api/assistant/costs/logs?conversationId=X — full per-message cost breakdown for a chat
 * GET /api/assistant/costs/logs?provider=X&range=today|7d|30d — per-provider, date-ranged logs
 * GET /api/assistant/costs/logs?provider=X&from=YYYY-MM-DD&to=YYYY-MM-DD — custom date window
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getRecentCostEvents, getConversationCostDetail, getProviderLogs } from '@/agent/lib/cost-logs'
import { todayYmdDhaka, daysAgoYmd } from '@/lib/agent-api/dhaka-date'
import { captureAgentError } from '@/agent/lib/sentry'

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

/** Resolve a from/to Dhaka date window from either a named range or explicit dates. */
function resolveWindow(range: string | null, fromParam: string | null, toParam: string | null): { from: string; to: string } {
  const today = todayYmdDhaka()
  if (fromParam && toParam && YMD_RE.test(fromParam) && YMD_RE.test(toParam)) {
    return fromParam <= toParam ? { from: fromParam, to: toParam } : { from: toParam, to: fromParam }
  }
  if (range === '7d') return { from: daysAgoYmd(6), to: today }
  if (range === '30d') return { from: daysAgoYmd(29), to: today }
  return { from: today, to: today } // default: today
}

export const runtime = 'nodejs'

async function authorizeOwner(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

export async function GET(req: NextRequest) {
  const denied = await authorizeOwner(req)
  if (denied) return denied

  try {
    const params = req.nextUrl.searchParams
    const conversationId = params.get('conversationId')
    if (conversationId) {
      const detail = await getConversationCostDetail(conversationId)
      if (!detail) return Response.json({ error: 'not_found' }, { status: 404 })
      return Response.json(detail)
    }

    const provider = params.get('provider')
    if (provider) {
      const { from, to } = resolveWindow(params.get('range'), params.get('from'), params.get('to'))
      const logs = await getProviderLogs(provider, from, to)
      return Response.json(logs)
    }

    const limitParam = parseInt(params.get('limit') ?? '100', 10)
    const events = await getRecentCostEvents(Number.isFinite(limitParam) ? limitParam : 100)
    return Response.json({ events })
  } catch (err) {
    console.error('[assistant/costs/logs GET]', err)
    void captureAgentError(err, 'costs.logs_get_failed', { route: 'costs/logs' })
    return Response.json({
      error: 'server_error',
      message: err instanceof Error ? err.message : 'Logs load failed',
    }, { status: 500 })
  }
}
