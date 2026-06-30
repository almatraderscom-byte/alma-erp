/**
 * WhatsApp voice notes (owner) — speak a message on WhatsApp like the agent does on
 * Telegram. WhatsApp media needs a PUBLIC URL Twilio can fetch, so we expose a tiny
 * token-signed endpoint (/api/twilio/wa-voice/[token]) that synthesizes the Bangla MP3
 * on demand; the token (HMAC + short expiry) keeps it from being an open TTS endpoint.
 *
 * Dormant until OWNER_WHATSAPP_NUMBER + Twilio creds + GOOGLE_TTS_CREDENTIALS are set.
 */
import { createHmac, createSign, timingSafeEqual } from 'crypto'
import { BANGLA_GOOGLE_TTS } from '@/agent/lib/voice-bangla'
import { sendTwilioWaMedia, twilioWaConfigured } from './twilio-wa'

const TOKEN_TTL_MS = 10 * 60 * 1000 // 10 min — Twilio fetches the media right away

function voiceSecret(): string {
  return process.env.AGENT_INTERNAL_TOKEN || process.env.NEXTAUTH_SECRET || ''
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

/** Sign a short-lived token carrying the text to speak. */
export function signVoiceToken(text: string, nowMs: number): string {
  const payload = b64url(Buffer.from(JSON.stringify({ t: text.slice(0, 600), e: nowMs + TOKEN_TTL_MS })))
  const sig = b64url(createHmac('sha256', voiceSecret()).update(payload).digest())
  return `${payload}.${sig}`
}

/** Verify a token and return the text, or null if invalid/expired. */
export function verifyVoiceToken(token: string, nowMs: number): string | null {
  const secret = voiceSecret()
  if (!secret) return null
  const [payload, sig] = String(token ?? '').split('.')
  if (!payload || !sig) return null
  const expected = b64url(createHmac('sha256', secret).update(payload).digest())
  try {
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  } catch {
    return null
  }
  try {
    const { t, e } = JSON.parse(fromB64url(payload).toString('utf8')) as { t?: string; e?: number }
    if (!t || !e || nowMs > e) return null
    return t
  } catch {
    return null
  }
}

function googleCreds(): { client_email: string; private_key: string } | null {
  const raw = process.env.GOOGLE_TTS_CREDENTIALS
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function googleAccessToken(creds: { client_email: string; private_key: string }, nowSec: number): Promise<string> {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      iss: creds.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  ).toString('base64url')
  const sign = createSign('RSA-SHA256')
  sign.update(`${header}.${payload}`)
  const signature = sign.sign(creds.private_key, 'base64url')
  const jwt = `${header}.${payload}.${signature}`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Google auth failed: ${await res.text()}`)
  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

/** Synthesize Bangla speech (MP3 bytes) via Google TTS. Returns null if unavailable. */
export async function synthesizeBanglaMp3(text: string, nowSec: number): Promise<Buffer | null> {
  const creds = googleCreds()
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)
  if (!creds || !clean) return null
  try {
    const accessToken = await googleAccessToken(creds, nowSec)
    const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        input: { text: clean },
        voice: { languageCode: BANGLA_GOOGLE_TTS.languageCode, name: BANGLA_GOOGLE_TTS.name },
        audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0 },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      console.warn('[wa-voice] google tts error:', res.status, await res.text().catch(() => ''))
      return null
    }
    const data = (await res.json()) as { audioContent: string }
    return Buffer.from(data.audioContent, 'base64')
  } catch (err) {
    console.warn('[wa-voice] synth failed:', err instanceof Error ? err.message : err)
    return null
  }
}

function appBase(): string {
  return (process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? 'https://alma-erp-six.vercel.app').replace(/\/$/, '')
}

/** Public URL Twilio fetches to get the spoken MP3. */
export function buildVoiceUrl(text: string, nowMs: number): string {
  return `${appBase()}/api/twilio/wa-voice/${signVoiceToken(text, nowMs)}.mp3`
}

/**
 * Send a spoken WhatsApp voice message to the owner. Best-effort + dormant. `caption`
 * optionally rides along as text under the audio.
 */
export async function sendOwnerWaVoice(
  text: string,
  nowMs: number,
  caption?: string,
): Promise<{ sent: boolean; reason?: string; sid?: string; error?: string }> {
  const to = process.env.OWNER_WHATSAPP_NUMBER
  if (!to) return { sent: false, reason: 'OWNER_WHATSAPP_NUMBER not set' }
  if (!twilioWaConfigured()) return { sent: false, reason: 'Twilio WhatsApp not configured' }
  if (!process.env.GOOGLE_TTS_CREDENTIALS) return { sent: false, reason: 'GOOGLE_TTS_CREDENTIALS not set' }
  if (!voiceSecret()) return { sent: false, reason: 'no signing secret (AGENT_INTERNAL_TOKEN/NEXTAUTH_SECRET)' }
  const res = await sendTwilioWaMedia({ to, mediaUrl: buildVoiceUrl(text, nowMs), body: caption })
  return { sent: !res.error, sid: res.sid, error: res.error }
}
