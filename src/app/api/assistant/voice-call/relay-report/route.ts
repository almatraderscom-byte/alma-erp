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
