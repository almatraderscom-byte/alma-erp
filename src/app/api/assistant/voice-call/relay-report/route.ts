/**
 * POST /api/assistant/voice-call/relay-report — ConversationRelay post-call report.
 *
 * The VPS relay server (worker/src/voice-relay/server.mjs) POSTs the transcript +
 * Gemini summary here when a two-way relay call ends. Internal-token authed (same
 * scheme as /internal/cost-event). Mirrors what the ElevenLabs post-call webhook
 * does for the legacy provider: update the agent_voice_calls row, then push the
 * owner a Bangla summary of what was said.
 */
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { persistVoiceCallReport, dispatchVoiceCallDeliveries, type VoiceCallTerminalStatus } from '@/agent/lib/voice-call-delivery'

export const runtime = 'nodejs'
export const maxDuration = 120

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

type TranscriptTurn = { role?: string; message?: string }

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: {
    callRecordId?: string
    callSid?: string | null
    transcript?: TranscriptTurn[]
    summary?: string | null
    durationSecs?: number | null
    status?: string
    /** Optional estimated call cost in whole BDT (ngs/Gemini Live path sends this). */
    costBdt?: number | null
    provider?: string | null
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const callRecordId = body.callRecordId
  if (!callRecordId) return Response.json({ error: 'missing_callRecordId' }, { status: 400 })

  const allowed = new Set<VoiceCallTerminalStatus>(['completed', 'no_answer', 'busy', 'failed'])
  const status = allowed.has(body.status as VoiceCallTerminalStatus)
    ? body.status as VoiceCallTerminalStatus : 'completed'
  const stored = await persistVoiceCallReport({
    callRecordId,
    callSid: body.callSid,
    transcript: body.transcript,
    summary: body.summary,
    durationSecs: body.durationSecs,
    status,
    costBdt: body.costBdt,
    provider: body.provider,
  })
  if (!stored) return Response.json({ error: 'call_not_found' }, { status: 404 })

  // Salah reminder calls ([salah:<waqt>] purpose): the SIP live bot has no
  // mark_salah tool, so the boss's spoken "পড়েছি" is honored HERE, from the
  // post-call transcript. Mirrors the native confirm-spoken route exactly:
  // caller-side turns ONLY (SIP transcripts use agent/caller roles — an
  // allowlist keeps the bot's own speech out), each gated by the strict
  // spoken-declaration predicate, and a generic confirmation binds to the
  // waqt THIS call reminded (review-bot P1 ×2).
  try {
    const { prisma } = await import('@/lib/prisma')
    const row = await prisma.agentVoiceCall.findUnique({
      where: { id: callRecordId }, select: { purpose: true, endedAt: true, dialedAt: true, createdAt: true },
    })
    const salahTag = row?.purpose?.match(/^\[salah:([a-z]+)(?::(\d{4}-\d{2}-\d{2}))?\]/)
    const salahWaqt = salahTag?.[1]
    const salahDate = salahTag?.[2]
    if (row && salahWaqt) {
      const CALLER_ROLES = new Set(['caller', 'user', 'boss', 'human'])
      const { isSpokenSalahDeclaration } = await import('@/agent/lib/salah-confirm-intent')
      const declarations = (body.transcript ?? [])
        .filter((t) => CALLER_ROLES.has(String(t.role ?? '').toLowerCase()))
        .map((t) => String(t.message ?? '').trim())
        .filter((t) => t && isSpokenSalahDeclaration(t))
        .map((t) => t.slice(0, 500))
      if (declarations.length) {
        const { applySalahAutoMarkFromUserTexts } = await import('@/agent/lib/salah-auto-mark')
        // Timestamp = call START (dial), not call end or report delivery: the
        // transcript carries no per-turn clock, and dialedAt errs EARLY — it
        // can never flip an on-time confirmation to prayed_late. A call that
        // straddles the window end was placed while the reminder was still
        // due, so the boss gets the on-time benefit (review-bot P2).
        const spokenAt = row.dialedAt ?? row.createdAt ?? row.endedAt ?? new Date()
        // ONE declaration per invocation, in transcript order — exactly how the
        // native confirm-spoken path serializes turns. A single batched call
        // would let markedKeys swallow a LATER correction ("পড়েছি" → "না,
        // কাযা হয়েছে") of the same waqt (review-bot P1).
        for (const declaration of declarations) {
          const marked = await applySalahAutoMarkFromUserTexts([declaration], spokenAt, {
            allowSettledCorrection: true,
            defaultWaqt: salahWaqt,
            // The tag's date pins the CALL's day — a report landing after
            // midnight (or delayed) must not drift to the report day (P1).
            defaultDateYmd: salahDate,
          })
          if (marked.marked.length) console.log('[relay-report] salah auto-marked from call:', marked.marked)
        }
      }
    }
  } catch (err) {
    // A transient failure HERE must not be acknowledged as delivered — the
    // durable senders delete their payload on 200 and nothing would ever
    // replay the transcript, silently losing the spoken confirmation
    // (review-bot P1). 503 keeps the sender's spool retrying; the report
    // persist above is authoritative-idempotent, so the replay is safe.
    console.warn('[relay-report] salah auto-mark failed; asking sender to retry:', err instanceof Error ? err.message : String(err))
    return Response.json({ error: 'salah_automark_failed' }, { status: 503 })
  }

  // Storage is the acknowledgement boundary. Owner-facing channels are independent,
  // durable outbox rows; try immediately for low latency, cron retries any failure.
  // Keep the worker ACK boundary short: Telegram is attempted immediately; push
  // and the potentially long head continuation are drained by the durable cron.
  const deliveries = await dispatchVoiceCallDeliveries(callRecordId, 1, ['telegram']).catch((err) => {
    console.warn('[relay-report] immediate delivery failed; cron will retry:', err instanceof Error ? err.message : String(err))
    return []
  })

  return Response.json({ ok: true, callId: callRecordId, deliveries })
}
