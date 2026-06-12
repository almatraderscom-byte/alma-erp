/**
 * Twilio voice call — Hermes-proven delivery pattern:
 *  1. Google TTS → 8 kHz mono WAV (ffmpeg)
 *  2. Upload to Supabase agent-files
 *  3. Proxy audio via APP_URL/api/twilio/audio (correct Content-Type for Twilio)
 *  4. Place call with Url → /api/twilio/twiml/salah-call (double Play + Say fallback)
 *  5. StatusCallback + auto Say-only retry when handset likely never rang
 *
 * Inline TwiML + direct Supabase signed URLs caused "completed 9s" ghost calls on BD networks.
 */

import { createHmac } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { synthesizeSpeech, mp3ToTelephonyWav } from '../tts.mjs'
import { logCost, calcTwilioCostUsd } from '../cost-log.mjs'

const CALL_TEXT_LIMIT = 200
/** Min gap between outbound calls — reduces carrier spam-blocking after back-to-back tests */
const MIN_CALL_GAP_MS = 90 * 1000
/** Completed shorter than this ≈ ghost connect (Twilio played audio, phone never rang) */
const GHOST_CONNECT_MAX_SEC = 12

let lastCallPlacedAt = 0

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  )
}

function signingSecret() {
  return process.env.AGENT_INTERNAL_TOKEN ?? process.env.TWILIO_AUTH_TOKEN ?? ''
}

function signAudioPath(storagePath, expMs) {
  return createHmac('sha256', signingSecret()).update(`${storagePath}:${expMs}`).digest('hex')
}

function buildProxiedAudioUrl(appUrl, storagePath, ttlSec = 900) {
  const exp = Date.now() + ttlSec * 1000
  const t = signAudioPath(storagePath, exp)
  const base = appUrl.replace(/\/$/, '')
  const params = new URLSearchParams({ path: storagePath, exp: String(exp), t })
  return `${base}/api/twilio/audio?${params.toString()}`
}

function buildTwimlCallbackUrl(appUrl, audioUrl, sayText) {
  const base = appUrl.replace(/\/$/, '')
  const params = new URLSearchParams({ audio: audioUrl })
  if (sayText?.trim()) params.set('say', sayText.slice(0, 400))
  return `${base}/api/twilio/twiml/salah-call?${params.toString()}`
}

function buildTwimlSayOnlyUrl(appUrl, sayText) {
  const base = appUrl.replace(/\/$/, '')
  return `${base}/api/twilio/twiml/salah-call?say=${encodeURIComponent(sayText.slice(0, 400))}`
}

async function fetchCall(accountSid, authToken, callSid) {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64')
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`,
    { headers: { Authorization: `Basic ${auth}` } },
  )
  return res.json()
}

async function placeCall({ accountSid, authToken, fromNumber, toNumber, twimlUrl, statusCallbackUrl }) {
  const body = new URLSearchParams({
    To:                  toNumber,
    From:                fromNumber,
    Url:                 twimlUrl,
    Method:              'GET',
    Timeout:             '45',
    StatusCallback:      statusCallbackUrl,
    StatusCallbackMethod:'POST',
    StatusCallbackEvent: 'completed no-answer busy failed',
  })

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      },
      body,
    },
  )
  const data = await res.json()
  if (!res.ok) {
    return { ok: false, error: `Twilio API ${res.status}: ${data?.message ?? JSON.stringify(data)}` }
  }
  return { ok: true, callSid: data.sid }
}

async function maybeRetrySayOnly({
  callSid,
  sayText,
  accountSid,
  authToken,
  fromNumber,
  toNumber,
  appUrl,
  statusCallbackUrl,
}) {
  await new Promise((r) => setTimeout(r, 18_000))
  try {
    const call = await fetchCall(accountSid, authToken, callSid)
    const dur = Number(call.duration ?? 0)
    const ghost = call.status === 'completed' && dur > 0 && dur < GHOST_CONNECT_MAX_SEC
    const missed = call.status === 'no-answer' || call.status === 'busy' || call.status === 'failed'
    if (!ghost && !missed) return

    console.warn(`[twilio] retry say-only (${call.status}, ${dur}s) after ghost/missed call ${callSid}`)

    if (Date.now() - lastCallPlacedAt < MIN_CALL_GAP_MS) {
      console.warn('[twilio] retry skipped — call cooldown')
      return
    }

    const twimlUrl = buildTwimlSayOnlyUrl(appUrl, sayText)
    const retry = await placeCall({
      accountSid,
      authToken,
      fromNumber,
      toNumber,
      twimlUrl,
      statusCallbackUrl,
    })
    if (retry.ok) {
      lastCallPlacedAt = Date.now()
      console.log('[twilio] say-only retry placed:', retry.callSid)
    }
  } catch (err) {
    console.warn('[twilio] retry check failed:', err.message)
  }
}

/**
 * @param {string} text
 * @returns {Promise<{ok:boolean, callSid?:string, error?:string, skipped?:boolean}>}
 */
export async function makeTwilioCall(text, opts = {}) {
  const force = Boolean(opts.force)
  const accountSid  = process.env.TWILIO_ACCOUNT_SID
  const authToken   = process.env.TWILIO_AUTH_TOKEN
  const fromNumber  = process.env.TWILIO_FROM_NUMBER
  const toNumber    = process.env.TWILIO_TO_NUMBER
  const appUrl      = (process.env.APP_URL ?? '').replace(/\/$/, '')

  if (!accountSid || !authToken || !fromNumber || !toNumber) {
    return { ok: false, error: 'Twilio env vars missing (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER / TWILIO_TO_NUMBER)' }
  }
  if (!appUrl) {
    return { ok: false, error: 'APP_URL missing — needed for TwiML/audio proxy (deploy Vercel routes first)' }
  }

  const now = Date.now()
  if (!force && now - lastCallPlacedAt < MIN_CALL_GAP_MS) {
    return { ok: false, error: 'call_cooldown', skipped: true }
  }

  let speechText = text.slice(0, CALL_TEXT_LIMIT)
  if (text.length > CALL_TEXT_LIMIT) speechText += '... বিস্তারিত Telegram-এ।'

  try {
    const mp3Buffer = await synthesizeSpeech(speechText, CALL_TEXT_LIMIT + 20)
    const wavBuffer = await mp3ToTelephonyWav(mp3Buffer)

    const supabase = getSupabase()
    const storagePath = `calls/call_${Date.now()}.wav`
    const { error: uploadErr } = await supabase.storage
      .from('agent-files')
      .upload(storagePath, wavBuffer, { contentType: 'audio/wav', upsert: true })
    if (uploadErr) throw new Error(`Supabase upload: ${uploadErr.message}`)

    const audioUrl = buildProxiedAudioUrl(appUrl, storagePath)
    const twimlUrl = buildTwimlCallbackUrl(appUrl, audioUrl, speechText)
    const statusCallbackUrl = `${appUrl}/api/twilio/call-status`

    const result = await placeCall({
      accountSid,
      authToken,
      fromNumber,
      toNumber,
      twimlUrl,
      statusCallbackUrl,
    })
    if (!result.ok) return result

    lastCallPlacedAt = now

    void logCost({
      provider: 'twilio',
      kind: 'call',
      units: { callSid: result.callSid, estimated_seconds: 60 },
      costUsd: calcTwilioCostUsd(60),
      jobId: result.callSid,
      dedupKey: `twilio:${result.callSid}`,
    })

    void maybeRetrySayOnly({
      callSid: result.callSid,
      sayText: speechText,
      accountSid,
      authToken,
      fromNumber,
      toNumber,
      appUrl,
      statusCallbackUrl,
    })

    return { ok: true, callSid: result.callSid }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
