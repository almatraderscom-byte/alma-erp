/**
 * POST /api/assistant/voice-call/sip-voicemail — a caller left a message because the AI
 * could not take the call.
 *
 * WHY THIS EXISTS: the AI answers inbound calls, so voicemail is not the normal path — it is
 * the safety net for when the assistant cannot speak (Gemini session refused, the bot process
 * down, the kill switch off). Before this, such a call was ANSWERED and then sat in silence,
 * which is the worst outcome: the customer believes they reached the business and got ignored.
 * Now they are asked to leave a message, and the owner gets it with the audio attached.
 *
 * The gateway has already uploaded the audio to Supabase; this route records it and notifies.
 *
 * Auth: Bearer AGENT_INTERNAL_TOKEN (the gateway runs on the VPS).
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'
import { isOwnerNumber } from '@/agent/lib/voice-call'

export const runtime = 'nodejs'
export const maxDuration = 30

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

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!bearerOk(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as {
    caller?: string; did?: string; url?: string; secs?: number
  }
  const caller = String(body.caller ?? '').trim() || 'unknown'
  const url = String(body.url ?? '').trim()
  const secs = Number(body.secs ?? 0) || null
  if (!url) return NextResponse.json({ ok: false, error: 'missing url' }, { status: 400 })

  const who = isOwnerNumber(caller) ? 'Boss' : caller
  const summary = `ভয়েসমেইল — সহকারী কলটি ধরতে পারেনি, তাই ${who} বার্তা রেখে গেছেন${secs ? ` (${secs} সেকেন্ড)` : ''}।`

  let recordId: string | null = null
  try {
    const rec = await db.agentVoiceCall.create({
      data: {
        toNumber: caller,
        recipientName: `ভয়েসমেইল: ${who}`,
        purpose: 'inbound_voicemail',
        firstMessage: '',
        status: 'completed',
        provider: 'sip',
        providerStatus: 'voicemail',
        summary,
        recordingUrl: url,
        recordingSecs: secs,
        endedAt: new Date(),
        reportReceivedAt: new Date(),
      },
    })
    recordId = rec.id
  } catch (err) {
    console.warn('[sip-voicemail] persist failed:', err instanceof Error ? err.message : String(err))
  }

  // Reach the owner right away: a missed customer is time-sensitive, and the whole point of
  // taking the message was that nobody was able to speak to them.
  const appUrl = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '')
  const token = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (appUrl && token) {
    void fetch(`${appUrl}/api/assistant/internal/urgent-alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        tier: 2,
        title: 'ভয়েসমেইল এসেছে',
        // voice:false — announcing a voicemail with a phone call would be absurd.
        message: `${summary} শুনুন: ${url}`,
        voice: false,
        category: 'inbound_voicemail',
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {})
  }

  return NextResponse.json({ ok: true, callRecordId: recordId })
}
