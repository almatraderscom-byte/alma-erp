import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { cancelLiveBrowserTurn } from '@/agent/lib/live-browser/companion'
import { isSystemOwner } from '@/lib/roles'

export const runtime = 'nodejs'

/**
 * Owner Stop button — real server-side cancel. The running turn lives in a
 * different serverless instance than this request, so we can't reach its
 * AbortController; instead we flip a DB flag the turn polls each iteration.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await Promise.resolve(params)
  if (!id) return Response.json({ error: 'turn_id_required' }, { status: 400 })

  try {
    // This returns only after the deterministic direct-browser lane is revoked,
    // the turn is terminal, and every still-queued command for it is failed.
    const result = await cancelLiveBrowserTurn(id)
    if (!result.found) return Response.json({ error: 'turn_not_found' }, { status: 404 })
    if ((result.inFlightEffects ?? 0) > 0) {
      return Response.json({
        ok: false,
        stopping: true,
        inFlightEffects: result.inFlightEffects,
        message: 'An already-authorized browser step is still finishing under preview; Stop is not complete yet.',
      }, { status: 202 })
    }
    return Response.json({ ok: true, canceledCommands: result.canceledCommands })
  } catch (error) {
    console.warn('[assistant/turn/cancel] durable cancel failed:', error instanceof Error ? error.message : error)
    return Response.json({ error: 'cancel_failed' }, { status: 500 })
  }
}
