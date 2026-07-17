import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { WHISPER_BANGLA_PROMPT, BANGLA_STT_MODEL } from '@/agent/lib/voice-bangla'
import { getToken } from 'next-auth/jwt'
import { requireAssistantHumanRequest } from '@/agent/lib/botid-protection'

export const runtime = 'nodejs'
export const maxDuration = 15

/**
 * Mints a short-lived ephemeral token for an OpenAI Realtime TRANSCRIPTION
 * session, so the browser can stream mic audio straight to OpenAI over
 * WebSocket and receive the transcript AS THE OWNER SPEAKS — true streaming
 * STT (voice-console gap #12). One token per turn; the console falls back to
 * the record-then-upload path if this route or the socket fails.
 *
 * Server VAD stays DISABLED (turn_detection: null): the console's own
 * adaptive endpointing decides when the utterance ended (owner-tuned
 * long-speech guarantees live there), then commits the buffer.
 */
export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const botBlocked = await requireAssistantHumanRequest(req, { route: '/api/assistant/stt-session' })
  if (botBlocked) return botBlocked

  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: 'OPENAI_API_KEY সেট করা নেই।' }, { status: 503 })
  }

  try {
    const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: 300 },
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              noise_reduction: { type: 'near_field' },
              transcription: {
                model: BANGLA_STT_MODEL,
                language: 'bn',
                prompt: WHISPER_BANGLA_PROMPT,
              },
              turn_detection: null,
            },
          },
        },
      }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return Response.json(
        { error: `stt session mint failed (${res.status})`, detail: detail.slice(0, 300) },
        { status: 502 },
      )
    }
    const data = await res.json() as { value?: string; client_secret?: { value?: string }; expires_at?: number }
    const key = data.value ?? data.client_secret?.value
    if (!key) return Response.json({ error: 'no ephemeral key in response' }, { status: 502 })
    return Response.json({ key, expiresAt: data.expires_at ?? null })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: `stt session mint failed: ${msg}` }, { status: 500 })
  }
}
