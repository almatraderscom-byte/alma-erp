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
import { prisma } from '@/lib/prisma'
import { notifyOwner } from '@/agent/lib/notify-owner'

export const runtime = 'nodejs'
export const maxDuration = 30

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

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
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const callRecordId = body.callRecordId
  if (!callRecordId) return Response.json({ error: 'missing_callRecordId' }, { status: 400 })

  const record = await db.agentVoiceCall.findUnique({ where: { id: callRecordId } }).catch(() => null)
  if (!record) return Response.json({ error: 'call_not_found' }, { status: 404 })

  const transcript = Array.isArray(body.transcript) ? body.transcript : []
  const summary = typeof body.summary === 'string' ? body.summary.slice(0, 2000) : null
  const durationSecs = Number.isFinite(body.durationSecs) ? Math.max(0, Math.round(Number(body.durationSecs))) : null
  const status = body.status === 'no_answer' ? 'no_answer' : 'completed'

  await db.agentVoiceCall.update({
    where: { id: callRecordId },
    data: {
      status,
      transcript,
      summary,
      durationSecs,
      callSid: record.callSid ?? body.callSid ?? null,
      endedAt: new Date(),
    },
  })

  // Same owner report format as the ElevenLabs webhook — who, how long, what was said.
  try {
    const who = record.recipientName || record.toNumber || 'কল'
    const mins = durationSecs != null ? `${Math.max(1, Math.round(durationSecs / 60))} মিনিট` : ''
    const lines = transcript
      .filter((t) => t.message)
      .map((t) => `${t.role === 'agent' ? '🗣️ এজেন্ট' : '👤 ' + who}: ${t.message}`)
      .join('\n')
    const message =
      `📞 কল শেষ — ${who}${mins ? ` (${mins})` : ''}\n\n` +
      (summary ? `সারাংশ: ${summary}\n\n` : '') +
      (lines ? `কথোপকথন:\n${lines}`.slice(0, 1500) : 'কেউ কথা বলেনি / কল ধরা হয়নি।')
    await notifyOwner({ tier: 2, title: `কল শেষ — ${who}`, message, category: 'report' })
  } catch (err) {
    console.warn('[relay-report] owner notify failed:', err instanceof Error ? err.message : String(err))
  }

  return Response.json({ ok: true, callId: callRecordId })
}
