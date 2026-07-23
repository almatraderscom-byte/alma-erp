/**
 * GET /api/cron/ngs-call-sweep — reliable outcome reporting for NGS outbound calls.
 *
 * NGS doesn't reliably call our statusCallback, so a call that never connects (busy/
 * no-answer/failed) would sit at 'ringing' forever and the owner would never be told.
 * This runs every minute: for each NGS call stuck at 'ringing' for >40s, it ASKS NGS the
 * real state and reports a failed outcome into the row + agent chat + Telegram (answered
 * calls are handled by the bot's /relay-report). Auth: Bearer CRON_SECRET.
 */
import { type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { reportNgsCallOutcome } from '@/agent/lib/ngs-call-outcome'
// AGENT_ENABLED kill switch via the ERP-safe shared flag — this ERP-side cron
// route must not import from src/agent/lib/guards (one-way boundary gate).
import { isAgentEnabled } from '@/lib/agent-runtime-flag'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function GET(req: NextRequest) {
  if (!isAgentEnabled()) return Response.json({ error: 'agent_disabled' }, { status: 503 })
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) return Response.json({ error: 'cron_unconfigured' }, { status: 503 })
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const now = Date.now()
  // Reconcile every unresolved NGS lifecycle state. Seven days keeps a wide repair
  // window without scanning historical completed rows; the previous 30-minute cutoff
  // permanently orphaned answered calls whose report callback was lost.
  const rows: Array<{ id: string }> = await db.agentVoiceCall.findMany({
    where: {
      OR: [
        { provider: 'ngs' },
        { provider: null, summary: { startsWith: 'ngs live:' } },
      ],
      status: { in: ['dispatching', 'ringing', 'answered', 'report_pending'] },
      callSid: { not: null },
      createdAt: { lte: new Date(now - 40_000), gte: new Date(now - 7 * 24 * 60 * 60_000) },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 50,
  })

  const results: Array<{ id: string; outcome: string }> = []
  // Bounded concurrency: avoid both a serial timeout and an NGS request spike.
  for (let offset = 0; offset < rows.length; offset += 5) {
    const batch = rows.slice(offset, offset + 5)
    const batchResults = await Promise.all(batch.map(async (row) => {
      try {
        return { id: row.id, outcome: await reportNgsCallOutcome(row.id) }
      } catch (err) {
        return { id: row.id, outcome: `error: ${err instanceof Error ? err.message : String(err)}` }
      }
    }))
    results.push(...batchResults)
  }
  return Response.json({ ok: true, checked: rows.length, results })
}
