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

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) return Response.json({ error: 'cron_unconfigured' }, { status: 503 })
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const now = Date.now()
  // Stuck 'ringing' calls: old enough to have resolved (>40s), not ancient (<30m).
  // reportNgsCallOutcome asks NGS by callSid and no-ops on a non-NGS SID (the NGS GET
  // returns nothing terminal → 'pending'), so it's safe to include any ringing row.
  const rows: Array<{ id: string }> = await db.agentVoiceCall.findMany({
    where: {
      status: 'ringing',
      callSid: { not: null },
      createdAt: { lte: new Date(now - 40_000), gte: new Date(now - 30 * 60_000) },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 15,
  })

  const results: Array<{ id: string; outcome: string }> = []
  for (const row of rows) {
    try {
      const outcome = await reportNgsCallOutcome(row.id)
      results.push({ id: row.id, outcome })
    } catch (err) {
      results.push({ id: row.id, outcome: `error: ${err instanceof Error ? err.message : String(err)}` })
    }
  }
  return Response.json({ ok: true, checked: rows.length, results })
}
