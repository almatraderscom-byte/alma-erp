/**
 * Google Cloud TTS (Bangla) — shared synthesis helper.
 *
 * Extracted from /api/assistant/tts so server-side features (camera speaker
 * announcements) can produce the SAME agent voice (bn-IN-Chirp3-HD-Charon)
 * without going through an HTTP route. Auth is the GOOGLE_TTS_CREDENTIALS
 * service account (JSON string env), exchanged for a short-lived access token.
 */
import { createSign } from 'crypto'
import { BANGLA_GOOGLE_TTS } from '@/agent/lib/voice-bangla'
import { calcTtsCostUsd } from '@/agent/lib/pricing'
import { logCost } from '@/agent/lib/cost-events'

interface GoogleCreds {
  client_email: string
  private_key: string
}

function getGoogleCredentials(): GoogleCreds | null {
  const raw = process.env.GOOGLE_TTS_CREDENTIALS
  if (!raw) return null
  try {
    return JSON.parse(raw) as GoogleCreds
  } catch (err) {
    console.warn('[google-tts] GOOGLE_TTS_CREDENTIALS parse failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export function googleTtsConfigured(): boolean {
  return getGoogleCredentials() !== null
}

async function getAccessToken(creds: GoogleCreds): Promise<string> {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url')

  const sign = createSign('RSA-SHA256')
  sign.update(`${header}.${payload}`)
  const signature = sign.sign(creds.private_key, 'base64url')
  const jwt = `${header}.${payload}.${signature}`

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!tokenRes.ok) {
    throw new Error(`Google auth failed: ${await tokenRes.text()}`)
  }
  const data = (await tokenRes.json()) as { access_token: string }
  return data.access_token
}

/**
 * Synthesize Bangla speech (agent voice) → MP3 buffer. Caller caps/cleans the
 * text; this trims to 600 chars as a final guard. Throws on failure.
 * costPurpose labels the spend in cost logs (e.g. 'web_voice', 'camera_speak').
 */
export async function synthesizeBanglaMp3(text: string, costPurpose: string): Promise<Buffer> {
  await (await import('@/agent/lib/models/cost-gate')).assertPaidCallAllowed(`tts:${costPurpose}`)
  const creds = getGoogleCredentials()
  if (!creds) throw new Error('GOOGLE_TTS_CREDENTIALS not configured')

  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 600)
  if (!clean) throw new Error('empty text')

  const accessToken = await getAccessToken(creds)
  const ttsRes = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      input: { text: clean },
      voice: { languageCode: BANGLA_GOOGLE_TTS.languageCode, name: BANGLA_GOOGLE_TTS.name },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0 },
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!ttsRes.ok) {
    throw new Error(`Google TTS error ${ttsRes.status}: ${(await ttsRes.text()).slice(0, 200)}`)
  }

  const data = (await ttsRes.json()) as { audioContent: string }
  const audio = Buffer.from(data.audioContent, 'base64')

  void logCost({
    provider: 'google_tts',
    kind: 'tts',
    units: { characters: clean.length, voice: BANGLA_GOOGLE_TTS.name, purpose: costPurpose },
    costUsd: calcTtsCostUsd(clean.length),
    dedupKey: `tts:${costPurpose}:${clean.length}:${clean.slice(0, 24)}`,
  })

  return audio
}
