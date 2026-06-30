/**
 * GET /api/twilio/wa-voice/<token>.mp3 — public, token-signed Bangla TTS audio for
 * WhatsApp voice notes. Twilio fetches this URL (no session), so access is gated by the
 * short-lived HMAC token built in wa-voice.ts, NOT by auth. Returns audio/mpeg.
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { verifyVoiceToken, synthesizeBanglaMp3 } from '@/agent/lib/wa/wa-voice'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = (params.token ?? '').replace(/\.mp3$/i, '')
  const now = Date.now()
  const text = verifyVoiceToken(token, now)
  if (!text) return new Response('invalid or expired token', { status: 403 })

  const mp3 = await synthesizeBanglaMp3(text, Math.floor(now / 1000))
  if (!mp3) return new Response('tts unavailable', { status: 503 })

  return new Response(mp3, {
    status: 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(mp3.length),
      'Cache-Control': 'public, max-age=600',
    },
  })
}
