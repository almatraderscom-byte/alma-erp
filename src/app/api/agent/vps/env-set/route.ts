import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'

export const runtime = 'nodejs'

/**
 * POST: Set an env var on the VPS worker (proxied through Vercel for auth).
 * Owner-only, forwards to worker's /env-set endpoint.
 */
export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const workerUrl = process.env.AGENT_WORKER_DIAGNOSTIC_URL?.replace(/\/$/, '')
  const internalToken = process.env.AGENT_INTERNAL_TOKEN

  if (!workerUrl || !internalToken) {
    return Response.json({
      error: 'config_missing',
      message: 'AGENT_WORKER_DIAGNOSTIC_URL or AGENT_INTERNAL_TOKEN not configured',
    }, { status: 503 })
  }

  const body = await req.json() as { key?: string; value?: string }

  if (!body.key || !body.value) {
    return Response.json({ error: 'key and value required' }, { status: 400 })
  }

  try {
    const res = await fetch(`${workerUrl}/env-set`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${internalToken}`,
      },
      body: JSON.stringify({ key: body.key, value: body.value }),
      signal: AbortSignal.timeout(15_000),
    })

    const data = await res.json().catch(() => ({}))
    return Response.json(data, { status: res.status })
  } catch (err) {
    return Response.json({
      error: 'vps_unreachable',
      message: err instanceof Error ? err.message : 'Unknown error',
    }, { status: 502 })
  }
}
