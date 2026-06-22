/**
 * GET /api/assistant/costs/logs            — recent spend events across all APIs (owner)
 * GET /api/assistant/costs/logs?conversationId=X — full per-message cost breakdown for a chat
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getRecentCostEvents, getConversationCostDetail } from '@/agent/lib/cost-logs'
import { captureAgentError } from '@/agent/lib/sentry'

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
    const conversationId = req.nextUrl.searchParams.get('conversationId')
    if (conversationId) {
      const detail = await getConversationCostDetail(conversationId)
      if (!detail) return Response.json({ error: 'not_found' }, { status: 404 })
      return Response.json(detail)
    }

    const limitParam = parseInt(req.nextUrl.searchParams.get('limit') ?? '100', 10)
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
