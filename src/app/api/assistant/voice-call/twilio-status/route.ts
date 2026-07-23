/**
 * POST /api/assistant/voice-call/twilio-status — Twilio call StatusCallback for the
 * relay/sarvam two-way pipeline (phone AND WhatsApp legs).
 *
 * Why: a Twilio call that never connects (busy / no-answer / failed / WhatsApp
 * call-permission missing) previously died silently — the row sat at 'ringing'
 * and the owner never heard back (live gap 2026-07-23). Terminal statuses now
 * report into the row + owner delivery via persistVoiceCallReport. Answered
 * calls stay owned by the worker's /relay-report (transcript + summary).
 *
 * WhatsApp extra: Twilio error 37000 = recipient never granted call permission.
 * We then AUTO-SEND the call-permission request template to that number and say
 * so honestly in the report, so the owner knows exactly what to expect next.
 *
 * Auth: signed per-call token (?id=<rowId>&t=HMAC(internalToken, "callstatus:"+id)).
 */
import { type NextRequest } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { persistVoiceCallReport } from '@/agent/lib/voice-call-delivery'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const TERMINAL_ROW_STATUSES = new Set(['completed', 'no_answer', 'busy', 'failed', 'report_missing'])

function verifyToken(id: string, provided: string): boolean {
  const secret = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!secret || !id || !provided) return false
  const expected = createHmac('sha256', secret).update(`callstatus:${id}`).digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const id = req.nextUrl.searchParams.get('id') ?? ''
  const t = req.nextUrl.searchParams.get('t') ?? ''
  if (!verifyToken(id, t)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const form = await req.formData().catch(() => null)
  if (!form) return Response.json({ error: 'bad_body' }, { status: 400 })
  const callStatus = String(form.get('CallStatus') ?? '').toLowerCase()
  const errorCode = String(form.get('ErrorCode') ?? '')
  const durationSecs = Number(form.get('CallDuration') ?? NaN)

  const row = await db.agentVoiceCall.findUnique({ where: { id } }).catch(() => null)
  if (!row) return Response.json({ ok: true, ignored: 'unknown_row' })
  if (TERMINAL_ROW_STATUSES.has(row.status)) return Response.json({ ok: true, ignored: 'already_terminal' })

  // Answered + completed normally → the relay bot's /relay-report owns the
  // transcript/summary; do not overwrite it from a bare status ping.
  if (callStatus === 'completed' && Number.isFinite(durationSecs) && durationSecs > 0) {
    return Response.json({ ok: true, ignored: 'answered_await_relay_report' })
  }

  const status: 'busy' | 'no_answer' | 'failed' =
    callStatus === 'busy' ? 'busy'
    : callStatus === 'no-answer' || (callStatus === 'completed' && durationSecs === 0) ? 'no_answer'
    : 'failed'

  const isWa = String(row.toNumber ?? '').length > 0 && errorCode === '37000'
  let summary: string
  if (isWa) {
    summary =
      'WhatsApp কলটা যায়নি — উনি এখনো WhatsApp-এ কল করার অনুমতি দেননি (Meta-র নিয়ম)। ' +
      'অনুমতি চাওয়ার message এখনই পাঠিয়ে দিয়েছি; উনি Allow চাপলে আবার কল করা যাবে।'
    try {
      const { requestWaCallPermission } = await import('@/agent/lib/wa/twilio-wa')
      const perm = await requestWaCallPermission(String(row.toNumber))
      if (perm.error) {
        summary =
          'WhatsApp কলটা যায়নি — কল করার অনুমতি নেই, আর অনুমতি-request পাঠাতেও সমস্যা হলো: ' +
          `${perm.error}`
      }
    } catch { /* best-effort */ }
  } else {
    summary =
      status === 'busy' ? 'নম্বরটা ব্যস্ত ছিল — কল সংযোগ হয়নি।'
      : status === 'no_answer' ? 'রিং হয়েছে কিন্তু কেউ ধরেননি।'
      : `কল সংযোগ হয়নি${errorCode ? ` (Twilio error ${errorCode})` : ''}।`
  }

  await persistVoiceCallReport({
    callRecordId: id,
    status,
    summary,
    durationSecs: Number.isFinite(durationSecs) ? durationSecs : undefined,
    authoritativeReport: false,
  })

  return Response.json({ ok: true, status })
}
