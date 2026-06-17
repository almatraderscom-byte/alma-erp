import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

/**
 * Retrigger a failed/missed agent duty.
 * Two-tier: writes a DB request (worker polls every 2 min), then also tries
 * the worker HTTP /retrigger for instant execution if available.
 */
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

  // 1. Write retrigger request to DB — worker polls this every 2 min
  const kvKey = `retrigger:${jobName}`
  const kvValue = JSON.stringify({
    jobName,
    status: 'pending',
    requestedAt: new Date().toISOString(),
  })

  await prisma.agentKvSetting.upsert({
    where: { key: kvKey },
    update: { value: kvValue },
    create: { key: kvKey, value: kvValue },
  })

  // 2. Try instant execution via worker HTTP (best-effort)
  let instant = false
  const workerUrl = process.env.AGENT_WORKER_DIAGNOSTIC_URL?.replace(/\/$/, '')
  const internalToken = process.env.AGENT_INTERNAL_TOKEN

  if (workerUrl && internalToken) {
    try {
      const res = await fetch(`${workerUrl}/retrigger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${internalToken}`,
        },
        body: JSON.stringify({ jobName }),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        instant = true
        const doneValue = JSON.stringify({
          jobName,
          status: 'done',
          requestedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          mode: 'instant',
        })
        await prisma.agentKvSetting.update({
          where: { key: kvKey },
          data: { value: doneValue },
        })
      } else {
        console.warn(`[retrigger] instant path HTTP ${res.status} for ${jobName}`)
      }
    } catch (err) {
      console.warn(`[retrigger] instant path failed for ${jobName}:`, err instanceof Error ? err.message : String(err))
    }
  }

  return Response.json({
    ok: true,
    jobName,
    mode: instant ? 'instant' : 'queued',
    message: instant
      ? 'Duty re-triggered instantly via worker'
      : 'Queued — worker will pick up within 2 minutes',
  })
}
