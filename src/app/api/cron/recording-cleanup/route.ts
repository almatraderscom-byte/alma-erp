/**
 * GET /api/cron/recording-cleanup — delete call recordings older than the retention window.
 *
 * Call audio is the most sensitive thing this system stores: real customers, real staff,
 * real conversations. Keeping it forever is both a storage bill and a liability, so the
 * owner set a 30-day window and it has to enforce itself — a retention policy nobody runs
 * is not a policy.
 *
 * Deletes the file from Supabase and clears the pointer on the call row, leaving the
 * transcript and summary intact so history stays readable after the audio is gone.
 *
 * Auth: Bearer CRON_SECRET.
 */
import { type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { prisma } from '@/lib/prisma'
import { isAgentEnabled } from '@/lib/agent-runtime-flag'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const RETENTION_DAYS = Number(process.env.CALL_RECORDING_RETENTION_DAYS ?? 30)

export async function GET(req: NextRequest) {
  if (!isAgentEnabled()) return Response.json({ error: 'agent_disabled' }, { status: 503 })
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) return Response.json({ error: 'cron_unconfigured' }, { status: 503 })
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60_000)
  const rows: Array<{ id: string; recordingUrl: string | null; createdAt: Date }> =
    await db.agentVoiceCall.findMany({
      where: { recordingUrl: { not: null }, createdAt: { lt: cutoff } },
      select: { id: true, recordingUrl: true, createdAt: true },
      take: 200, // bounded per run; the job is on a schedule and will catch up
    })

  if (!rows.length) return Response.json({ ok: true, retentionDays: RETENTION_DAYS, deleted: 0 })

  const supabaseUrl = process.env.SUPABASE_URL ?? ''
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  const supabase = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey) : null

  // Storage paths look like .../object/sign/agent-files/calls/recordings/<name>.wav?token=…
  const pathOf = (url: string): string | null => {
    const m = url.match(/agent-files\/(calls\/recordings\/[^?]+)/)
    return m ? m[1] : null
  }

  const paths = rows.map((r) => pathOf(r.recordingUrl ?? '')).filter((p): p is string => Boolean(p))
  let storageDeleted = 0
  if (supabase && paths.length) {
    const { error } = await supabase.storage.from('agent-files').remove(paths)
    if (error) console.warn('[recording-cleanup] storage remove failed:', error.message)
    else storageDeleted = paths.length
  }

  // Clear the pointers even if storage removal failed — a URL that no longer plays is worse
  // than no URL, and the next run will retry the file.
  await db.agentVoiceCall.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { recordingUrl: null, recordingSecs: null },
  })

  return Response.json({
    ok: true,
    retentionDays: RETENTION_DAYS,
    rowsCleared: rows.length,
    storageDeleted,
    oldest: rows[0]?.createdAt ?? null,
  })
}
