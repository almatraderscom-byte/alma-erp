/**
 * GET/POST /api/assistant/voice-call/ngs-status?rid=<agent_voice_calls.id>&k=<secret>
 *
 * Best-effort NGS statusCallback endpoint. In practice NGS does NOT reliably call this, so
 * the RELIABLE outcome reporting is /api/cron/ngs-call-sweep (which polls NGS). This exists
 * for the case where NGS does ping us, and shares the same reportNgsCallOutcome logic.
 * Guarded by the ?k shared secret (NGS_INBOUND_SECRET) + requireAgentEnabled.
 */
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { reportNgsCallOutcome } from '@/agent/lib/ngs-call-outcome'

export const runtime = 'nodejs'
export const maxDuration = 20

function secretOk(provided: string): boolean {
  const expected = process.env.NGS_INBOUND_SECRET ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8'); const b = Buffer.from(provided, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  } catch { return false }
}

const ok = () => Response.json({ ok: true })

export async function POST(req: NextRequest) { return handle(req) }
export async function GET(req: NextRequest) { return handle(req) }

async function handle(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return ok() // never error back to the carrier
  const url = new URL(req.url)
  if (!secretOk(url.searchParams.get('k') ?? '')) return ok()
  const rid = url.searchParams.get('rid') ?? ''
  if (rid) await reportNgsCallOutcome(rid).catch(() => {})
  return ok()
}
