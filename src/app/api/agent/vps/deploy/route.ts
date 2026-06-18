import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const maxDuration = 180

type DeployStep = { step: string; ok: boolean; output?: string; error?: string }

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
      signal: AbortSignal.timeout(110_000),
    })

    const data = await res.json().catch(() => ({})) as {
      ok?: boolean; steps?: DeployStep[]; error?: string; healthCheck?: string
      prevCommit?: string | null; targetCommit?: string | null
    }

    // Accept 207 (partial success) as well
    if (!res.ok && res.status !== 207) {
      return Response.json({
        error: 'deploy_failed',
        message: data.error ?? `Worker returned ${res.status}`,
        steps: data.steps,
      }, { status: 502 })
    }

    // Verify the restart actually landed the new code: poll /health until the
    // worker reports a bootCommit equal to the just-pulled targetCommit. This is
    // the real success signal — pm2_restart can't report its own outcome because
    // the restart kills the process answering the deploy request.
    const restartScheduled = data.steps?.find((s) => s.step === 'pm2_restart' && s.ok)
    let verified = false
    let runningCommit: string | null = null
    if (restartScheduled && data.targetCommit) {
      const deadline = Date.now() + 45_000
      // Give pm2 a moment to tear down + boot before the first poll.
      await new Promise(r => setTimeout(r, 4000))
      while (Date.now() < deadline) {
        try {
          const healthRes = await fetch(`${workerUrl}/health`, {
            headers: { Authorization: `Bearer ${internalToken}` },
            signal: AbortSignal.timeout(8_000),
          })
          const healthData = await healthRes.json().catch(() => ({})) as { ok?: boolean; bootCommit?: string | null }
          runningCommit = healthData.bootCommit ?? null
          if (runningCommit && runningCommit === data.targetCommit) { verified = true; break }
        } catch { /* worker mid-restart — keep polling */ }
        await new Promise(r => setTimeout(r, 3000))
      }
    }
    data.healthCheck = verified ? 'verified' : (restartScheduled ? 'unconfirmed' : 'skipped')

    // Store result
    const record = {
      ts: new Date().toISOString(),
      ok: data.ok, steps: data.steps ?? [], healthCheck: data.healthCheck,
      verified, prevCommit: data.prevCommit ?? null, targetCommit: data.targetCommit ?? null, runningCommit,
    }
    try {
      await prisma.agentKvSetting.upsert({
        where: { key: 'worker.lastDeploy' },
        update: { value: JSON.stringify(record) },
        create: { key: 'worker.lastDeploy', value: JSON.stringify(record) },
      })
    } catch (err) {
      console.warn('[deploy] KV write for lastDeploy failed:', err)
    }

    return Response.json({
      ok: Boolean(data.ok) && verified,
      verified,
      steps: data.steps,
      healthCheck: data.healthCheck,
      prevCommit: data.prevCommit ?? null,
      targetCommit: data.targetCommit ?? null,
      runningCommit,
    })
  } catch (err) {
    return Response.json({
      error: 'deploy_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: 'worker.lastDeploy' } })
    if (!row) return Response.json({ lastDeploy: null })
    return Response.json({ lastDeploy: JSON.parse(row.value) })
  } catch {
    return Response.json({ lastDeploy: null })
  }
}
