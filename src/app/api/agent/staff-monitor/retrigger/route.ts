import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const body = await req.json().catch(() => null)
  if (!body?.jobName || typeof body.jobName !== 'string') {
    return Response.json({ error: 'jobName required' }, { status: 400 })
  }

  const { jobName } = body as { jobName: string }

  const workerUrl = process.env.AGENT_WORKER_DIAGNOSTIC_URL?.replace(/\/$/, '')
  const internalToken = process.env.AGENT_INTERNAL_TOKEN

  if (!workerUrl || !internalToken) {
    return Response.json({
      error: 'config_missing',
      message: 'AGENT_WORKER_DIAGNOSTIC_URL or AGENT_INTERNAL_TOKEN not configured',
    }, { status: 503 })
  }

  try {
    const res = await fetch(`${workerUrl}/retrigger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${internalToken}`,
      },
      body: JSON.stringify({ jobName }),
      signal: AbortSignal.timeout(30_000),
    })

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      return Response.json({
        error: 'worker_error',
        message: data.error ?? `Worker returned ${res.status}`,
      }, { status: 502 })
    }

    return Response.json({ ok: true, jobName, workerResponse: data })
  } catch (err) {
    console.error('[staff-monitor/retrigger]', err)
    return Response.json({
      error: 'retrigger_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    }, { status: 500 })
  }
}
