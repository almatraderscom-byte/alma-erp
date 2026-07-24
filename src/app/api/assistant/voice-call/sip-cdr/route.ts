/**
 * POST /api/assistant/voice-call/sip-cdr — durable call record from the self-hosted SIP
 * gateway, written when a call ends.
 *
 * WHY: the gateway keeps its call records in memory, so a restart would take call history,
 * outcomes and cost with it. Worse, for a TRANSFERRED call this is the only trace that
 * exists at all — once the AI hands the caller to a human it steps off the audio path and
 * never learns whether the human answered or how long they spoke. Persisting here closes
 * both gaps (owner-flagged risks, 2026-07-25).
 *
 * Deliberately NON-authoritative: the bot's own post-call report (/relay-report) carries the
 * transcript and summary and always wins. This route only fills in what is missing and never
 * overwrites a report that already landed.
 *
 * Auth: Bearer AGENT_INTERNAL_TOKEN (the gateway runs on the VPS).
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const maxDuration = 20

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

function bearerOk(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  const got = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!expected || !got) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(got, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** Statuses that mean "this call is finished and already explained" — never overwrite them. */
const SETTLED = new Set(['completed', 'no_answer', 'busy', 'failed', 'report_missing'])

interface CdrBody {
  call_id?: string
  direction?: string
  to?: string
  from?: string
  did?: string
  answered?: boolean
  startedAt?: number
  answeredAt?: number
  endedAt?: number
  status?: string
  cause?: number | null
  causeTxt?: string
  digit?: string | null
  confirmOutcome?: string
  transferredTo?: string
  transferredAt?: number
  transferAnswered?: boolean
  transferTalkSecs?: number
  transferCauseTxt?: string
}

/** Human-readable Bangla note about a transfer, so the owner learns what happened after the AI left. */
function transferNote(c: CdrBody): string | null {
  if (!c.transferredTo) return null
  if (!c.transferAnswered) {
    return `কলটি ${c.transferredTo} নম্বরে যুক্ত করার চেষ্টা হয়েছিল, কিন্তু কেউ ধরেননি।`
  }
  const secs = Math.max(0, Number(c.transferTalkSecs ?? 0))
  const mins = Math.floor(secs / 60)
  const dur = mins > 0 ? `${mins} মিনিট ${secs % 60} সেকেন্ড` : `${secs} সেকেন্ড`
  return `কলটি ${c.transferredTo} নম্বরে যুক্ত করা হয়েছিল; দুজনে ${dur} কথা বলেছেন।`
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!bearerOk(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const c = (await req.json().catch(() => ({}))) as CdrBody
  const callSid = String(c.call_id ?? '').trim()
  if (!callSid) return NextResponse.json({ ok: false, error: 'missing call_id' }, { status: 400 })

  const durationSecs =
    c.answeredAt && c.endedAt ? Math.max(0, Math.round((c.endedAt - c.answeredAt) / 1000)) : null
  const note = transferNote(c)

  try {
    const existing = await db.agentVoiceCall.findFirst({
      where: { callSid },
      select: { id: true, status: true, summary: true, reportReceivedAt: true, durationSecs: true },
    })

    if (existing) {
      const reported = Boolean(existing.reportReceivedAt)
      await db.agentVoiceCall.update({
        where: { id: existing.id },
        data: {
          // The bot's report is authoritative — only settle a row it has not already settled.
          ...(reported || SETTLED.has(existing.status) ? {} : { status: c.status ?? existing.status }),
          providerStatus: c.status ?? undefined,
          endedAt: c.endedAt ? new Date(c.endedAt) : new Date(),
          ...(c.answeredAt ? { answeredAt: new Date(c.answeredAt) } : {}),
          ...(durationSecs != null && !existing.durationSecs ? { durationSecs } : {}),
          // A transfer note is appended even to a reported row: the bot's summary describes
          // only the part it witnessed, and the human half is exactly what was missing.
          ...(note ? { summary: existing.summary ? `${existing.summary} ${note}` : note } : {}),
        },
      })
      return NextResponse.json({ ok: true, callRecordId: existing.id, updated: true })
    }

    // No row — a worker-placed message call or an inbound call answered on the gateway's
    // fail-safe path. Record it so call history is complete rather than silently missing.
    const created = await db.agentVoiceCall.create({
      data: {
        toNumber: String(c.to ?? c.from ?? 'unknown'),
        recipientName: c.direction === 'inbound' ? `ইনকামিং কল: ${c.from ?? 'অজানা'}` : null,
        purpose: c.direction === 'inbound' ? 'inbound_call' : 'one_way_call',
        firstMessage: '',
        status: c.status ?? 'completed',
        provider: 'sip',
        providerStatus: c.status ?? null,
        callSid,
        ...(c.answeredAt ? { answeredAt: new Date(c.answeredAt) } : {}),
        ...(c.startedAt ? { dialedAt: new Date(c.startedAt) } : {}),
        endedAt: c.endedAt ? new Date(c.endedAt) : new Date(),
        ...(durationSecs != null ? { durationSecs } : {}),
        ...(note ? { summary: note } : {}),
      },
    })
    return NextResponse.json({ ok: true, callRecordId: created.id, created: true })
  } catch (err) {
    console.warn('[sip-cdr] persist failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: false, error: 'persist_failed' }, { status: 500 })
  }
}
