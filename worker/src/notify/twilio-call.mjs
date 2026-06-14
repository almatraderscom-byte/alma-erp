/**
 * Twilio voice call — Hermes-proven delivery pattern:
 *  1. Google TTS → 8 kHz mono WAV (ffmpeg)
 *  2. Upload to Supabase agent-files
 *  3. Proxy audio via APP_URL/api/twilio/audio (correct Content-Type for Twilio)
 *  4. Place call with Url → /api/twilio/twiml/salah-call (double Play + Say fallback)
 *  5. StatusCallback + auto Say-only retry when handset likely never rang
 *
 * Salah calls use a separate retry policy: 3m / 5m / 5m retries, cooldown bypassed.
 */

import { createClient } from '@supabase/supabase-js'
import { synthesizeSpeech, mp3ToTelephonyWav } from '../tts.mjs'
import { logCost, calcTwilioCostUsd } from '../cost-log.mjs'
import {
  buildProxiedAudioUrl,
  buildTwimlCallbackUrl,
  buildTwimlSayOnlyUrl,
  getTwilioPublicBase,
} from '../twilio-http.mjs'

const CALL_TEXT_LIMIT = 200
/** Min gap between general outbound calls — reduces carrier spam-blocking */
const MIN_CALL_GAP_MS = 90 * 1000
/** Salah retries: wait after failed connect, then call again (owner may be on another line) */
const SALAH_RETRY_DELAYS_MS = [180_000, 300_000, 300_000]
/** Completed shorter than this ≈ ghost connect (Twilio played audio, phone never rang) */
const GHOST_CONNECT_MAX_SEC = 12

let lastCallPlacedAt = 0

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  )
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
  })
  for (const event of ['completed', 'no-answer', 'busy', 'failed']) {
    body.append('StatusCallbackEvent', event)
  }

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

const TERMINAL_CALL_STATUSES = new Set(['completed', 'no-answer', 'busy', 'failed', 'canceled'])

function callNeedsRetry(call) {
  if (!call) return true
  const dur = Number(call.duration ?? 0)
  if (call.status === 'busy' || call.status === 'no-answer' || call.status === 'failed') return true
  if (call.status === 'completed' && dur > 0 && dur < GHOST_CONNECT_MAX_SEC) return true
  return false
}

async function waitForTerminalCall(callSid, accountSid, authToken, maxWaitMs = 50_000) {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000))
    try {
      const call = await fetchCall(accountSid, authToken, callSid)
      if (TERMINAL_CALL_STATUSES.has(call.status)) return call
    } catch (err) {
      console.warn('[twilio] poll failed:', err.message)
      return null
    }
  }
  return null
}

async function placeSayOnlyRetry({
  sayText,
  accountSid,
  authToken,
  fromNumber,
  toNumber,
  appUrl,
  statusCallbackUrl,
  skipCooldown = false,
}) {
  if (!skipCooldown && Date.now() - lastCallPlacedAt < MIN_CALL_GAP_MS) {
    return { ok: false, error: 'call_cooldown', skipped: true }
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
    void logCost({
      provider: 'twilio',
      kind: 'call',
      units: { callSid: retry.callSid, estimated_seconds: 60, retry: true },
      costUsd: calcTwilioCostUsd(60),
      jobId: retry.callSid,
      dedupKey: `twilio:${retry.callSid}`,
    })
  }
  return retry
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
    if (!callNeedsRetry(call)) return

    console.warn(`[twilio] retry say-only (${call.status}, ${call.duration ?? 0}s) after ghost/missed call ${callSid}`)
    const retry = await placeSayOnlyRetry({
      sayText,
      accountSid,
      authToken,
      fromNumber,
      toNumber,
      appUrl,
      statusCallbackUrl,
    })
    if (retry.ok) {
      console.log('[twilio] say-only retry placed:', retry.callSid)
    } else if (retry.skipped) {
      console.warn('[twilio] retry skipped — call cooldown')
    }
  } catch (err) {
    console.warn('[twilio] retry check failed:', err.message)
  }
}

/** Salah-only: retry 3m / 5m / 5m after busy, no-answer, or ghost connect — bypasses global cooldown. */
async function scheduleSalahCallRetries({
  initialCallSid,
  sayText,
  accountSid,
  authToken,
  fromNumber,
  toNumber,
  appUrl,
  statusCallbackUrl,
}) {
  let call = await waitForTerminalCall(initialCallSid, accountSid, authToken, 50_000)
  if (!call) {
    try {
      call = await fetchCall(accountSid, authToken, initialCallSid)
    } catch {
      call = null
    }
  }

  if (!callNeedsRetry(call)) {
    console.log(`[twilio/salah] initial call ok (${call?.status}, ${call?.duration ?? 0}s)`)
    return
  }

  console.warn(`[twilio/salah] initial call needs retry (${call?.status}, ${call?.duration ?? 0}s) — ${SALAH_RETRY_DELAYS_MS.length} attempts scheduled`)

  let lastSid = initialCallSid
  for (let i = 0; i < SALAH_RETRY_DELAYS_MS.length; i++) {
    const delayMs = SALAH_RETRY_DELAYS_MS[i]
    console.log(`[twilio/salah] retry ${i + 1} in ${Math.round(delayMs / 1000)}s`)
    await new Promise((r) => setTimeout(r, delayMs))

    const retry = await placeSayOnlyRetry({
      sayText,
      accountSid,
      authToken,
      fromNumber,
      toNumber,
      appUrl,
      statusCallbackUrl,
      skipCooldown: true,
    })
    if (!retry.ok) {
      console.warn(`[twilio/salah] retry ${i + 1} place failed:`, retry.error)
      continue
    }

    lastSid = retry.callSid
    console.log(`[twilio/salah] retry ${i + 1} placed:`, lastSid)

    call = await waitForTerminalCall(lastSid, accountSid, authToken, 50_000)
    if (!call) {
      try {
        call = await fetchCall(accountSid, authToken, lastSid)
      } catch {
        call = null
      }
    }

    if (!callNeedsRetry(call)) {
      console.log(`[twilio/salah] retry ${i + 1} connected (${call?.status}, ${call?.duration ?? 0}s)`)
      return
    }
    console.warn(`[twilio/salah] retry ${i + 1} still missed (${call?.status}, ${call?.duration ?? 0}s)`)
  }
}

/**
 * @param {string} text
 * @param {{ force?: boolean, salah?: boolean, skipAutoRetry?: boolean, toNumber?: string }} opts
 * @returns {Promise<{ok:boolean, callSid?:string, error?:string, skipped?:boolean}>}
 */
export async function makeTwilioCall(text, opts = {}) {
  const force = Boolean(opts.force)
  const salah = Boolean(opts.salah)
  const accountSid  = process.env.TWILIO_ACCOUNT_SID
  const authToken   = process.env.TWILIO_AUTH_TOKEN
  const fromNumber  = process.env.TWILIO_FROM_NUMBER
  const toNumber    = opts.toNumber ?? process.env.TWILIO_TO_NUMBER
  const publicBase  = getTwilioPublicBase()
  const appUrl      = (process.env.APP_URL ?? '').replace(/\/$/, '')

  if (!accountSid || !authToken || !fromNumber || !toNumber) {
    return { ok: false, error: 'Twilio env vars missing (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER / destination number)' }
  }

  const now = Date.now()
  const bypassCooldown = salah || force
  if (!bypassCooldown && now - lastCallPlacedAt < MIN_CALL_GAP_MS) {
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

    const audioUrl = buildProxiedAudioUrl(publicBase, storagePath)
    const twimlUrl = buildTwimlCallbackUrl(publicBase, audioUrl, speechText)
    const statusCallbackUrl = appUrl
      ? `${appUrl}/api/twilio/call-status`
      : `${publicBase}/call-status`

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
      units: { callSid: result.callSid, estimated_seconds: 60, salah },
      costUsd: calcTwilioCostUsd(60),
      jobId: result.callSid,
      dedupKey: `twilio:${result.callSid}`,
    })

    if (!opts.skipAutoRetry) {
      const retryCtx = {
        callSid: result.callSid,
        sayText: speechText,
        accountSid,
        authToken,
        fromNumber,
        toNumber,
        appUrl: publicBase,
        statusCallbackUrl,
      }
      if (salah) {
        void scheduleSalahCallRetries({ initialCallSid: result.callSid, ...retryCtx })
      } else {
        void maybeRetrySayOnly(retryCtx)
      }
    }

    return { ok: true, callSid: result.callSid, publicBase }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * Poll Twilio until call ends, then POST status to app (fallback if StatusCallback fails).
 */
export async function pollAndReportCallResult(callSid, toNumber) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const appUrl = (process.env.APP_URL ?? '').replace(/\/$/, '')
  if (!accountSid || !authToken || !appUrl || !callSid) return

  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 3000))
    try {
      const call = await fetchCall(accountSid, authToken, callSid)
      if (!TERMINAL_CALL_STATUSES.has(call.status)) continue

      const body = new URLSearchParams({
        CallStatus: call.status,
        CallDuration: String(call.duration ?? 0),
        CallSid: callSid,
        To: toNumber,
      })
      const res = await fetch(`${appUrl}/api/twilio/call-status`, { method: 'POST', body })
      console.log(`[twilio] polled call result ${callSid} → ${call.status} (${call.duration ?? 0}s) HTTP ${res.status}`)
      return
    } catch (err) {
      console.warn('[twilio] poll call result failed:', err.message)
      return
    }
  }
  console.warn(`[twilio] poll timeout for call ${callSid}`)
}
