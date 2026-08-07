import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { GoogleGenAI } from '@google/genai'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import {
  buildLiveVoiceTokenConfig,
  GEMINI_31_LIVE_MODEL,
  isSupportedLiveVoiceModel,
  isSupportedLiveVoiceName,
} from '@/agent/lib/live-voice-config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 15

type LiveSessionSelection = { model?: unknown; voice?: unknown }

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

  const requested = await req.json().catch(() => ({})) as LiveSessionSelection
  const configuredModel = process.env.GEMINI_LIVE_APP_MODEL?.trim()
  const configuredVoice = process.env.GEMINI_LIVE_APP_VOICE?.trim()
  const requestedModel = typeof requested.model === 'string' ? requested.model.trim() : ''
  const requestedVoice = typeof requested.voice === 'string' ? requested.voice.trim() : ''
  // Old iOS builds post an empty body. Keep their proven 3.1/Charon baseline;
  // only the new native selector opts into 2.5/Aoede or another preset.
  const model = requestedModel || configuredModel || GEMINI_31_LIVE_MODEL
  const voice = requestedVoice || configuredVoice || 'Charon'
  if (!isSupportedLiveVoiceModel(model)) {
    return Response.json({ error: 'unsupported_live_model' }, { status: 400 })
  }
  if (!isSupportedLiveVoiceName(voice)) {
    return Response.json({ error: 'unsupported_live_voice' }, { status: 400 })
  }
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString()
  // 120s (was 60s): the native app now prewarms this token when an agent call
  // RINGS (ring window 75s) — the new-session window must outlive the whole
  // ring plus answer/connect latency, or a late answer hands Google a token
  // that can no longer open a session (Codex P1, PR #657). Single-use + the
  // 30-minute hard expiry above still bound the exposure.
  const newSessionExpiresAt = new Date(Date.now() + 120_000).toISOString()

  try {
    // Current Gemini Live ephemeral-token transport is v1beta. Besides being
    // the documented endpoint, this is required for Gemini 2.5 affective dialog;
    // v1alpha rejected the setup and forced the iOS client to downgrade it.
    const client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1beta' } })
    const token = await client.authTokens.create({
      config: {
        uses: 1,
        expireTime: expiresAt,
        newSessionExpireTime: newSessionExpiresAt,
        liveConnectConstraints: { model, config: buildLiveVoiceTokenConfig(voice, model) },
        // Lock the fields present above, but allow the client to add only the
        // sessionResumption.handle required for Google's ~10-minute socket rotation.
        lockAdditionalFields: [],
        httpOptions: { apiVersion: 'v1beta' },
      },
    })
    if (!token.name) return Response.json({ error: 'no_ephemeral_token' }, { status: 502 })

    return Response.json({
      token: token.name,
      model,
      voice,
      affectiveDialog: model === 'gemini-2.5-flash-native-audio-preview-12-2025',
      expiresAt,
      websocketUrl: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[live-session] token mint failed:', message)
    return Response.json({ error: 'live_session_mint_failed', detail: message.slice(0, 300) }, { status: 502 })
  }
}
