/**
 * GET /api/cron/call-escalations — PA-2 proactive-call ladder tick (every minute).
 * 1. Scans triggers (stuck approvals, stuck staff tasks) into agent_call_escalations.
 * 2. Walks each due row through WhatsApp call → PSTN call → summary push.
 * Auth: Bearer CRON_SECRET, same as the other crons.
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { scanEscalationTriggers, processCallEscalations } from '@/agent/lib/proactive-call'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) return Response.json({ error: 'cron_unconfigured' }, { status: 503 })
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const scan = await scanEscalationTriggers()
  const steps = await processCallEscalations(10)
  return Response.json({ ok: true, queued: scan.queued, processed: steps.length, steps })
}
