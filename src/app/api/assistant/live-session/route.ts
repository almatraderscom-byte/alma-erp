import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { GoogleGenAI } from '@google/genai'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import {
  buildLiveVoiceTokenConfig,
  DEFAULT_LIVE_VOICE_MODEL,
  DEFAULT_LIVE_VOICE_NAME,
} from '@/agent/lib/live-voice-config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 15

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const owner = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!owner?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(owner)) return Response.json({ error: 'forbidden' }, { status: 403 })
  if (process.env.LIVE_VOICE_ENABLED === 'false') {
    return Response.json({ error: 'live_voice_disabled' }, { status: 503 })
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim()
  if (!apiKey) return Response.json({ error: 'GEMINI_API_KEY সেট করা নেই।' }, { status: 503 })

  const model = process.env.GEMINI_LIVE_APP_MODEL?.trim() || DEFAULT_LIVE_VOICE_MODEL
  const voice = process.env.GEMINI_LIVE_APP_VOICE?.trim() || DEFAULT_LIVE_VOICE_NAME
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString()
  const newSessionExpiresAt = new Date(Date.now() + 60_000).toISOString()

  try {
    const client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } })
    const token = await client.authTokens.create({
      config: {
        uses: 1,
        expireTime: expiresAt,
        newSessionExpireTime: newSessionExpiresAt,
        liveConnectConstraints: { model, config: buildLiveVoiceTokenConfig(voice) },
        // Lock the fields present above, but allow the client to add only the
        // sessionResumption.handle required for Google's ~10-minute socket rotation.
        lockAdditionalFields: [],
        httpOptions: { apiVersion: 'v1alpha' },
      },
    })
    if (!token.name) return Response.json({ error: 'no_ephemeral_token' }, { status: 502 })

    return Response.json({
      token: token.name,
      model,
      voice,
      expiresAt,
      websocketUrl: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[live-session] token mint failed:', message)
    return Response.json({ error: 'live_session_mint_failed', detail: message.slice(0, 300) }, { status: 502 })
  }
}
