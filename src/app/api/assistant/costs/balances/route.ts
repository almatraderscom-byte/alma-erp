/**
 * GET  /api/assistant/costs/balances — cached API balances (owner)
 * POST /api/assistant/costs/balances — force refresh + return cache
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getApiBalances } from '@/agent/lib/api-balances'
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
    const refresh = req.nextUrl.searchParams.get('refresh') === '1'
    const cache = await getApiBalances({ refresh })
    return Response.json(cache)
  } catch (err) {
    console.error('[assistant/costs/balances GET]', err)
    void captureAgentError(err, 'costs.balances_get_failed', { route: 'costs/balances' })
    return Response.json({
      error: 'server_error',
      message: err instanceof Error ? err.message : 'Balance load failed',
    }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const denied = await authorizeOwner(req)
  if (denied) return denied

  try {
    const cache = await getApiBalances({ refresh: true })
    return Response.json(cache)
  } catch (err) {
    console.error('[assistant/costs/balances POST]', err)
    void captureAgentError(err, 'costs.balances_refresh_failed', { route: 'costs/balances' })
    return Response.json({
      error: 'server_error',
      message: err instanceof Error ? err.message : 'Balance refresh failed',
    }, { status: 500 })
  }
}
