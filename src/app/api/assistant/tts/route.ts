import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { calcTtsCostUsd } from '@/agent/lib/pricing'
import { logCost } from '@/agent/lib/cost-events'
import { BANGLA_GOOGLE_TTS } from '@/agent/lib/voice-bangla'
import { getToken } from 'next-auth/jwt'

export const runtime = 'nodejs'
export const maxDuration = 30

/** Strip markdown before synthesis (asterisks, backticks, headings, etc.). */
function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, '')         // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1')      // italic
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '') // inline + block code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/^[-*+]\s+/gm, '')        // bullet points
    .replace(/^\d+\.\s+/gm, '')        // numbered lists
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Load Google credentials — supports JSON string env or file path. */
function getGoogleCredentials(): { client_email: string; private_key: string } | null {
  const raw = process.env.GOOGLE_TTS_CREDENTIALS
  if (!raw) return null

  // Try to parse as JSON string first
  try {
    return JSON.parse(raw)
  } catch (err) {
    console.warn('[tts] GOOGLE_TTS_CREDENTIALS parse failed (not JSON):', err instanceof Error ? err.message : err)
    return null
  }
}

async function getAccessToken(creds: { client_email: string; private_key: string }): Promise<string> {
  // Create a signed JWT for Google Cloud service account
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url')

  // Sign with RS256 using the private key
  const { createSign } = await import('crypto')
  const sign = createSign('RSA-SHA256')
  sign.update(`${header}.${payload}`)
  const signature = sign.sign(creds.private_key, 'base64url')
  const jwt = `${header}.${payload}.${signature}`

  // Exchange JWT for access token
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
    const err = await tokenRes.text()
    throw new Error(`Google auth failed: ${err}`)
  }
  const data = await tokenRes.json() as { access_token: string }
  return data.access_token
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  // Any authenticated user — the staff navigator speaks the assistant's reply via
  // Google TTS (text→audio only, no ERP data exposed). The owner agent also uses this.
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const creds = getGoogleCredentials()
  if (!creds) {
    return Response.json(
      { error: 'GOOGLE_TTS_CREDENTIALS সেট করা নেই। Vercel-এ GOOGLE_TTS_CREDENTIALS (JSON string) যোগ করুন।' },
      { status: 503 },
    )
  }

  let body: { text?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid request body' }, { status: 400 })
  }

  const rawText = String(body.text ?? '').trim()
  if (!rawText) return Response.json({ error: 'text is required' }, { status: 400 })

  // Strip markdown and cap at ~600 chars
  const cleaned = stripMarkdown(rawText)
  const text = cleaned.slice(0, 600)
  if (!text) return Response.json({ error: 'text is required' }, { status: 400 })

  try {
    const accessToken = await getAccessToken(creds)

    const ttsRes = await fetch(
      'https://texttospeech.googleapis.com/v1/text:synthesize',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          input: { text },
          voice: {
            languageCode: BANGLA_GOOGLE_TTS.languageCode,
            name: BANGLA_GOOGLE_TTS.name,
          },
          audioConfig: {
            audioEncoding: 'MP3',
            speakingRate: 1.0,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    )

    if (!ttsRes.ok) {
      const errBody = await ttsRes.text()
      throw new Error(`Google TTS error ${ttsRes.status}: ${errBody}`)
    }

    const data = await ttsRes.json() as { audioContent: string }
    const audioBuffer = Buffer.from(data.audioContent, 'base64')

    const charCount = text.length
    void logCost({
      provider: 'google_tts',
      kind: 'tts',
      units: { characters: charCount, voice: BANGLA_GOOGLE_TTS.name, purpose: 'web_voice' },
      costUsd: calcTtsCostUsd(charCount),
      dedupKey: `tts:web:${charCount}:${text.slice(0, 24)}`,
    })

    return new Response(audioBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(audioBuffer.length),
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: `TTS ব্যর্থ হয়েছে: ${msg}` }, { status: 500 })
  }
}
