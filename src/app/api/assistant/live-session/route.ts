import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { GoogleGenAI } from '@google/genai'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import {
  buildLegacyLiveVoiceTokenConfig,
  buildLiveVoiceTokenConfig,
  GEMINI_31_LIVE_MODEL,
  isSupportedLiveVoiceModel,
  isSupportedLiveVoiceName,
} from '@/agent/lib/live-voice-config'
import {
  LIVE_VOICE_CONTRACT,
  liveVoiceModelContract,
  liveVoiceRemoteModelAvailability,
  liveVoiceRolloutDefaults,
} from '@/agent/lib/live-voice-contract'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 15

type LiveSessionSelection = { model?: unknown; voice?: unknown; contractVersion?: unknown }

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
  // A constrained token rejects a client setup whose value for a locked field
  // differs from the token's, and installed pre-contract builds send the
  // session values they shipped with — minting them a contract-v2 token killed
  // every live call on those builds the day the contract reached production
  // (greeting from the app's local latency path, then silence). Builds that
  // speak the contract prove it by echoing contractVersion in this request;
  // everything else gets the frozen pre-contract config it was proven against.
  const contractClient = typeof requested.contractVersion === 'string'
    && requested.contractVersion.trim().length > 0
  // One contract now owns new-client defaults. The temporary environment gate
  // atomically restores the old empty-body 3.1/Charon behavior during rollout.
  const contractRolloutEnabled = process.env.LIVE_VOICE_PHASE1B_CONTRACT_V1 !== 'false'
  const rolloutDefaults = liveVoiceRolloutDefaults(contractRolloutEnabled, {
    modelID: GEMINI_31_LIVE_MODEL,
    voiceID: 'Charon',
  })
  const model = requestedModel || configuredModel || rolloutDefaults.modelID
  const voice = requestedVoice || configuredVoice || rolloutDefaults.voiceID
  if (!isSupportedLiveVoiceModel(model)) {
    return Response.json({ error: 'unsupported_live_model' }, { status: 400 })
  }
  if (!isSupportedLiveVoiceName(voice)) {
    return Response.json({ error: 'unsupported_live_voice' }, { status: 400 })
  }
  const availability = liveVoiceRemoteModelAvailability(
    model,
    process.env.LIVE_VOICE_DISABLED_MODEL_IDS,
  )
  if (!availability.enabled) {
    return Response.json({
      error: 'live_model_remotely_disabled',
      replacementModel: availability.replacementModelID,
      contractVersion: LIVE_VOICE_CONTRACT.contractVersion,
    }, { status: 503 })
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
        liveConnectConstraints: {
          model,
          config: contractClient
            ? buildLiveVoiceTokenConfig(voice, model)
            : buildLegacyLiveVoiceTokenConfig(voice, model),
        },
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
      contractVersion: contractRolloutEnabled ? LIVE_VOICE_CONTRACT.contractVersion : 'legacy',
      affectiveDialog: liveVoiceModelContract(model)?.capabilities.affectiveDialog ?? false,
      expiresAt,
      websocketUrl: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[live-session] token mint failed:', message)
    return Response.json({ error: 'live_session_mint_failed', detail: message.slice(0, 300) }, { status: 502 })
  }
}
