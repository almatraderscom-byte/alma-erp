import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'

export const runtime = 'nodejs'

/**
 * Trigger a git pull + pm2 restart on the VPS worker.
 * Proxies to the worker's diagnostic HTTP /deploy endpoint.
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

  try {
    const res = await fetch(`${workerUrl}/deploy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${internalToken}`,
      },
      body: '{}',
      signal: AbortSignal.timeout(90_000),
    })

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      return Response.json({
        error: 'deploy_failed',
        message: data.error ?? `Worker returned ${res.status}`,
      }, { status: 502 })
    }

    return Response.json({ ok: true, output: data.output ?? '' })
  } catch (err) {
    return Response.json({
      error: 'deploy_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    }, { status: 500 })
  }
}
