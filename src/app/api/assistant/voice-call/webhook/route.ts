/**
 * ElevenLabs Conversational AI post-call webhook.
 *
 * After an agent-placed phone call ends, ElevenLabs POSTs the full transcript +
 * summary here. We verify the HMAC-SHA256 signature, match the call to its
 * `agent_voice_calls` row (by conversation_id), store the transcript, and push the
 * owner a Bangla summary so he learns what the other person said — the whole point
 * of the feature ("ami cai sheta shunuk er por amk janak").
 *
 * Signature scheme (ElevenLabs): header `ElevenLabs-Signature: t=<ts>,v0=<hex>`,
 * signing string `"<ts>.<rawBody>"`, HMAC-SHA256 with the webhook secret. We reject
 * stale timestamps (> 30 min) to block replay.
 */
import { type NextRequest } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'
import { notifyOwner } from '@/agent/lib/notify-owner'

export const runtime = 'nodejs'
export const maxDuration = 30

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const MAX_AGE_SECS = 30 * 60

/** Verify the ElevenLabs HMAC-SHA256 signature over `"<timestamp>.<rawBody>"`. */
function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=')
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]
    }),
  )
  const ts = parts['t']
  const sig = parts['v0']
  if (!ts || !sig) return false

  // Reject stale/replayed deliveries.
  const tsNum = Number(ts)
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > MAX_AGE_SECS) return false

  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(sig, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

type TranscriptTurn = { role?: string; message?: string; time_in_call_secs?: number }

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET ?? ''
  const rawBody = await req.text()
  const sigHeader = req.headers.get('elevenlabs-signature')

  if (!verifySignature(rawBody, sigHeader, secret)) {
    return Response.json({ error: 'invalid_signature' }, { status: 401 })
  }

  let body: {
    type?: string
    data?: {
      conversation_id?: string
      status?: string
      transcript?: TranscriptTurn[]
      metadata?: {
        call_duration_secs?: number
        cost?: number
        phone_call?: { call_sid?: string; external_number?: string }
      }
      analysis?: { transcript_summary?: string; call_summary_title?: string }
    }
  }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  // Only act on the transcription event; ignore audio/other event types.
  if (body.type && body.type !== 'post_call_transcription') {
    return Response.json({ ok: true, ignored: body.type })
  }

  const data = body.data
  const convId = data?.conversation_id
  if (!convId) return Response.json({ error: 'missing_conversation_id' }, { status: 400 })

  const transcript = data?.transcript ?? []
  const summary = data?.analysis?.transcript_summary ?? null
  const durationSecs = data?.metadata?.call_duration_secs ?? null
  const costCredits = data?.metadata?.cost ?? null
  const callSid = data?.metadata?.phone_call?.call_sid ?? null

  // Match by conversation_id (set when the call was placed). Fall back to the most
  // recent ringing/initiated row for this number if the id never landed.
  let record = await db.agentVoiceCall.findUnique({ where: { elevenConvId: convId } }).catch(() => null)
  if (!record) {
    const extNum = data?.metadata?.phone_call?.external_number
    if (extNum) {
      record = await db.agentVoiceCall.findFirst({
        where: { toNumber: extNum, status: { in: ['initiated', 'ringing'] } },
        orderBy: { createdAt: 'desc' },
      }).catch(() => null)
    }
  }

  if (record) {
    await db.agentVoiceCall.update({
      where: { id: record.id },
      data: {
        elevenConvId: convId,
        status: 'completed',
        transcript,
        summary,
        durationSecs,
        costCredits,
        callSid: record.callSid ?? callSid,
        endedAt: new Date(),
      },
    })
  } else {
    // Unmatched call (e.g. inbound or pre-feature). Store for the record anyway.
    record = await db.agentVoiceCall.create({
      data: {
        elevenConvId: convId,
        toNumber: data?.metadata?.phone_call?.external_number ?? 'unknown',
        status: 'completed',
        transcript,
        summary,
        durationSecs,
        costCredits,
        callSid,
        endedAt: new Date(),
      },
    })
  }

  // Push the owner the result — who was called, how long, and what was said.
  try {
    const who = record.recipientName || record.toNumber || 'কল'
    const mins = durationSecs != null ? `${Math.round(durationSecs / 60)} মিনিট` : ''
    const lines = transcript
      .filter((t) => t.message)
      .map((t) => `${t.role === 'agent' ? '🗣️ এজেন্ট' : '👤 ' + who}: ${t.message}`)
      .join('\n')
    const message =
      `📞 কল শেষ — ${who}${mins ? ` (${mins})` : ''}\n\n` +
      (summary ? `সারাংশ: ${summary}\n\n` : '') +
      (lines ? `কথোপকথন:\n${lines}`.slice(0, 1500) : 'কোনো কথোপকথন পাওয়া যায়নি।')
    await notifyOwner({ tier: 2, title: `কল শেষ — ${who}`, message, category: 'report' })
  } catch (err) {
    console.warn('[voice-call webhook] owner notify failed:', err instanceof Error ? err.message : String(err))
  }

  return Response.json({ ok: true, callId: record.id })
}
