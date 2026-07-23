// CS12 — per-engine health for the Studio: last-7-day volume, error rate,
// latency percentiles, spend, QC pass rate, plus kill-switch/canary state,
// worker heartbeat and live provider balances (fal + direct FASHN).
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { readKv } from '@/lib/creative-studio/taste'
import {
  CS_AUTO_CANARY_PCT_KEY,
  STUDIO_ENGINES,
  engineKillKey,
  normalizeCanaryPct,
  type StudioEngineId,
} from '@/lib/creative-studio/provider-registry'
import { percentile } from '@/lib/creative-studio/eval-types'
import { readBalanceCache } from '@/agent/lib/api-balances'

export const runtime = 'nodejs'
export const maxDuration = 30

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const WINDOW_DAYS = 7

type EngineHealth = {
  engine: string
  labelBn: string
  jobs: number
  failed: number
  errorRatePct: number
  qcPassRatePct: number | null
  p50LatencyMs: number | null
  p95LatencyMs: number | null
  spendUsd: number
  killed: boolean
}

function engineOfRow(payload: Record<string, unknown>, result: Record<string, unknown>): string {
  return (
    (result.falEngine as string | undefined)
    ?? (payload.falEngine as string | undefined)
    // CS13 — xai rows carry xaiEngine ('xai_imagine'); provider is just 'xai'
    ?? (result.xaiEngine as string | undefined)
    ?? (payload.xaiEngine as string | undefined)
    ?? (result.provider as string | undefined)
    ?? (payload.provider as string | undefined)
    ?? 'gemini'
  )
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000)
  const rows = await db.agentPendingAction.findMany({
    where: {
      type: { in: ['image_gen', 'video_gen', 'video_edit'] },
      createdAt: { gte: since },
      status: { in: ['executed', 'failed'] },
    },
    select: { status: true, payload: true, result: true },
    take: 1000,
    orderBy: { createdAt: 'desc' },
  })

  type Agg = { jobs: number; failed: number; qcPass: number; qcTotal: number; latencies: number[]; spend: number }
  const byEngine = new Map<string, Agg>()
  for (const row of rows as Array<{ status: string; payload: unknown; result: unknown }>) {
    const payload = (row.payload ?? {}) as Record<string, unknown>
    if (payload.creativeStudio !== true && payload.chainInternal !== true) continue
    const result = (row.result ?? {}) as Record<string, unknown>
    const engine = engineOfRow(payload, result)
    const agg = byEngine.get(engine) ?? { jobs: 0, failed: 0, qcPass: 0, qcTotal: 0, latencies: [], spend: 0 }
    agg.jobs++
    if (row.status === 'failed') agg.failed++
    const qc = result.qc as { pass?: boolean } | undefined
    if (qc && typeof qc.pass === 'boolean') {
      agg.qcTotal++
      if (qc.pass) agg.qcPass++
    }
    const lat = Number(result.latencyMs)
    if (Number.isFinite(lat) && lat > 0) agg.latencies.push(lat)
    const cost = Number(result.costUsd)
    if (Number.isFinite(cost) && cost > 0) agg.spend += cost
    byEngine.set(engine, agg)
  }

  const kills: Partial<Record<StudioEngineId, boolean>> = {}
  for (const e of STUDIO_ENGINES) {
    kills[e.id] = (await readKv(engineKillKey(e.id))) === '1'
  }

  const LABELS: Record<string, string> = {
    fashn: 'FASHN Pro (direct)',
    fal_fashn_v16: 'Fal FASHN v1.6',
    fal_idm_vton: 'IDM-VTON',
    fal_flux_fill: 'FLUX Fill',
    xai_imagine: 'Grok Imagine (xAI)',
    gemini: 'Gemini',
    family_composite: '🛡 কম্পোজিট',
    veo: 'Veo রিল',
  }

  const engines: EngineHealth[] = [...byEngine.entries()]
    .map(([engine, a]) => ({
      engine,
      labelBn: LABELS[engine] ?? engine,
      jobs: a.jobs,
      failed: a.failed,
      errorRatePct: a.jobs ? Math.round((a.failed / a.jobs) * 1000) / 10 : 0,
      qcPassRatePct: a.qcTotal ? Math.round((a.qcPass / a.qcTotal) * 1000) / 10 : null,
      p50LatencyMs: a.latencies.length ? percentile(a.latencies, 50) : null,
      p95LatencyMs: a.latencies.length ? percentile(a.latencies, 95) : null,
      spendUsd: Math.round(a.spend * 1000) / 1000,
      killed: Boolean(kills[engine as StudioEngineId]),
    }))
    .sort((x, y) => y.jobs - x.jobs)

  // Live balances (cached by the balance refresher): fal + direct FASHN.
  let balances: Array<{ id: string; label: string; balanceUsd: number | null; monthUsd: number | null }> = []
  try {
    const cache = await readBalanceCache()
    balances = (cache?.providers ?? [])
      .filter((p: { id: string }) => ['fal', 'fashn', 'veo', 'gemini'].includes(p.id))
      .map((p: { id: string; label: string; balanceUsd: number | null; monthUsd: number | null }) => ({
        id: p.id, label: p.label, balanceUsd: p.balanceUsd, monthUsd: p.monthUsd,
      }))
  } catch { /* balances optional */ }

  const heartbeat = await readKv('worker_heartbeat_at')
  const heartbeatAgeSec = heartbeat ? Math.round((Date.now() - new Date(heartbeat).getTime()) / 1000) : null

  return Response.json({
    windowDays: WINDOW_DAYS,
    engines,
    kills,
    canaryPct: normalizeCanaryPct(await readKv(CS_AUTO_CANARY_PCT_KEY)),
    worker: {
      heartbeatAt: heartbeat,
      heartbeatAgeSec,
      healthy: heartbeatAgeSec !== null && heartbeatAgeSec < 180,
    },
    balances,
  })
}
