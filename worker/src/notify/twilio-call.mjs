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
import { isOwnerCallLocked } from '../owner-call-lock.mjs'
import { isSalahCallBlocked } from '../salah-confirmed.mjs'

const CALL_TEXT_LIMIT = 200
/** playOnce (message-delivery) calls: full message, pure safety bound only */
const MESSAGE_CALL_TEXT_LIMIT = 2000
/** Min gap between general outbound calls — reduces carrier spam-blocking */

async function synthesizeCallAudio(speechText, opts = {}) {
  const isSalah = Boolean(opts.salah || opts.purpose === 'salah')
  const callOpts = { purpose: 'phone_call' }
  // Always ≥ the actual text so synthesizeSpeech never re-truncates it
  // (its internal 200-char chunking is per-request splitting, not truncation).
  const ttsMaxChars = speechText.length + 20
  // Salah reminders + an explicit Google request stay on Google Charon (proven, unchanged).
  if (isSalah || opts.ttsProvider === 'google') {
    return synthesizeSpeech(speechText, ttsMaxChars, callOpts)
  }
  if (opts.ttsProvider === 'elevenlabs' || opts.useElevenLabs) {
    const { synthesizeElevenLabs, isElevenLabsAvailable } = await import('../tts-elevenlabs.mjs')
    if (!isElevenLabsAvailable()) {
      return synthesizeSarvamOrGoogle(speechText, ttsMaxChars, callOpts, opts)
    }
    const voiceProfile = opts.voiceProfile === 'female' ? 'female' : 'male'
    return synthesizeElevenLabs(speechText, { voiceProfile, ...callOpts })
  }
  // Default (owner decision 2026-07-18): Sarvam Bulbul — more natural Bangla than
  // Google's bn-IN Charon. Any Sarvam failure (missing key, network, quota) silently
  // falls back to Google so a call is never left without audio.
  return synthesizeSarvamOrGoogle(speechText, ttsMaxChars, callOpts, opts)
}

/** Sarvam Bulbul with an automatic, silent fallback to Google Charon on any failure. */
async function synthesizeSarvamOrGoogle(speechText, ttsMaxChars, callOpts, opts) {
  const { synthesizeSarvam, isSarvamAvailable } = await import('../tts-sarvam.mjs')
  if (isSarvamAvailable()) {
    try {
      // Owner voices (2026-07-18): female = anushka/bulbul:v2, male = ashutosh/bulbul:v3.
      // Speaker + model travel together — ashutosh lives only on v3, anushka on v2.
      const isMale = opts.voiceProfile === 'male'
      const speaker = isMale
        ? (process.env.SARVAM_TTS_SPEAKER_MALE || 'ashutosh')
        : (process.env.SARVAM_TTS_SPEAKER || 'anushka')
      const model = isMale
        ? (process.env.SARVAM_TTS_MODEL_MALE || 'bulbul:v3')
        : (process.env.SARVAM_TTS_MODEL || 'bulbul:v2')
      return await synthesizeSarvam(speechText, { speaker, model, ...callOpts })
    } catch (err) {
      console.warn('[twilio-call] Sarvam TTS failed → Google fallback:', err.message)
    }
  }
  return synthesizeSpeech(speechText, ttsMaxChars, callOpts)
}
const MIN_CALL_GAP_MS = 90 * 1000
/** Salah retries: wait after failed connect, then call again (owner may be on another line) */
const SALAH_RETRY_DELAYS_MS = [180_000, 300_000, 300_000]
/** Completed shorter than this ≈ ghost connect (Twilio played audio, phone never rang) */
const GHOST_CONNECT_MAX_SEC = 12

let lastCallPlacedAt = 0

/** Salah reminders only — never used for agent/urgent/reminder calls. */
function resolveTwilioFromNumber(opts = {}) {
  const isSalah = Boolean(opts.salah || opts.purpose === 'salah')
  const defaultFrom = process.env.TWILIO_FROM_NUMBER
  const salahFrom = process.env.TWILIO_SALAH_FROM_NUMBER
  if (isSalah && salahFrom) return { fromNumber: salahFrom, dedicatedSalah: true }
  return { fromNumber: defaultFrom, dedicatedSalah: false }
}

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
  salahDate,
  salahWaqt,
}) {
  const lock = await isOwnerCallLocked()
  if (lock.locked) {
    console.log(`[twilio] retry blocked — owner call lock until ${lock.until?.toISOString()} (${lock.source})`)
    return { ok: false, error: 'owner_call_locked', skipped: true }
  }

  if (salahDate && salahWaqt) {
    const salahBlock = await isSalahCallBlocked(salahDate, salahWaqt)
    if (salahBlock.blocked) {
      console.log(`[twilio/salah] retry blocked — ${salahWaqt} confirmed for ${salahDate}`)
      return { ok: false, error: 'salah_confirmed', skipped: true }
    }
  }

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
  salahDate,
  salahWaqt,
}) {
  if (salahDate && salahWaqt) {
    const preBlock = await isSalahCallBlocked(salahDate, salahWaqt)
    if (preBlock.blocked) {
      console.log(`[twilio/salah] retry loop skipped — ${salahWaqt} already confirmed for ${salahDate}`)
      return
    }
  }

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

  if (salahDate && salahWaqt) {
    const postBlock = await isSalahCallBlocked(salahDate, salahWaqt)
    if (postBlock.blocked) {
      console.log(`[twilio/salah] retries aborted after initial call — ${salahWaqt} confirmed for ${salahDate}`)
      return
    }
  }

  console.warn(`[twilio/salah] initial call needs retry (${call?.status}, ${call?.duration ?? 0}s) — ${SALAH_RETRY_DELAYS_MS.length} attempts scheduled`)

  let lastSid = initialCallSid
  for (let i = 0; i < SALAH_RETRY_DELAYS_MS.length; i++) {
    const delayMs = SALAH_RETRY_DELAYS_MS[i]
    console.log(`[twilio/salah] retry ${i + 1} in ${Math.round(delayMs / 1000)}s`)
    await new Promise((r) => setTimeout(r, delayMs))

    const lock = await isOwnerCallLocked()
    if (lock.locked) {
      console.log(`[twilio/salah] retries aborted — owner call lock until ${lock.until?.toISOString()} (${lock.source})`)
      return
    }

    if (salahDate && salahWaqt) {
      const salahBlock = await isSalahCallBlocked(salahDate, salahWaqt)
      if (salahBlock.blocked) {
        console.log(`[twilio/salah] retries aborted — ${salahWaqt} confirmed for ${salahDate}`)
        return
      }
    }

    const retry = await placeSayOnlyRetry({
      sayText,
      accountSid,
      authToken,
      fromNumber,
      toNumber,
      appUrl,
      statusCallbackUrl,
      skipCooldown: true,
      salahDate,
      salahWaqt,
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
 * One-way message call over the infosoftbd (NextGenSwitch) BD number — same TTS voice
 * as the Twilio path, but the receiver sees the local BD caller-ID (09649777738) instead
 * of the US +1 number. Mirrors the proven one-way recipe (memory / ngs-test-call.mjs):
 * Sarvam/Google TTS → 8 kHz WAV → Supabase → **clean HTTPS signed URL** (the worker
 * proxy URL returns NGS "No route found"; a Supabase signed URL works) → NGS
 * /api/v1/call with <play>…</play><hangup/>. No retry/cooldown/salah logic here — this
 * is the simple message-delivery path; salah + ghost-retry stay on Twilio.
 *
 * Creds: NGS_KEY/NGS_SECRET (bot-style) or NGS_API_KEY/NGS_API_SECRET (voice-call.ts-style).
 * @returns {Promise<{ok:boolean, callSid?:string, error?:string}>}
 */
export async function makeNgsCall(text, opts = {}) {
  const apiBase = (process.env.NGS_API_BASE || 'https://alma-traders.infosoftbd.com').replace(/\/$/, '')
  const key = process.env.NGS_KEY || process.env.NGS_API_KEY
  const secret = process.env.NGS_SECRET || process.env.NGS_API_SECRET
  const from = process.env.NGS_FROM || '2323'
  const toNumber = opts.toNumber ?? process.env.NGS_TO ?? process.env.TWILIO_TO_NUMBER
  if (!key || !secret || !toNumber) {
    return { ok: false, error: 'NGS one-way env missing (NGS_KEY/NGS_SECRET + destination)' }
  }
  const speechText = text.slice(0, MESSAGE_CALL_TEXT_LIMIT)
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  try {
    const mp3Buffer = await synthesizeCallAudio(speechText, opts)
    const wavBuffer = await mp3ToTelephonyWav(mp3Buffer)
    const supabase = getSupabase()
    const storagePath = `calls/ngs_${Date.now()}.wav`
    const { error: uploadErr } = await supabase.storage
      .from('agent-files')
      .upload(storagePath, wavBuffer, { contentType: 'audio/wav', upsert: true })
    if (uploadErr) throw new Error(`Supabase upload: ${uploadErr.message}`)
    // Clean HTTPS signed URL — the proxy URL (with query args) makes NGS reply "No route found".
    const { data: signed, error: signErr } = await supabase.storage
      .from('agent-files')
      .createSignedUrl(storagePath, 3600)
    if (signErr || !signed?.signedUrl) throw new Error(`signed url: ${signErr?.message ?? 'none'}`)
    // Exact tags from the proven one-way recipe (ngs-live-call.mjs): capitalized
    // <Response><Play>…</Play><Hangup/>. (Two-way uses lowercase <connect><stream>.)
    const responseXml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      `<Response><Play>${esc(signed.signedUrl)}</Play><Hangup/></Response>`
    const res = await fetch(`${apiBase}/api/v1/call`, {
      method: 'POST',
      headers: { 'X-Authorization': key, 'X-Authorization-Secret': secret, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ to: toNumber, from, responseXml }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.call_id) {
      return { ok: false, error: `NGS ${res.status}: ${JSON.stringify(data).slice(0, 160)}` }
    }
    console.log(`[ngs] one-way call placed ${data.call_id} → ${toNumber}`)
    return { ok: true, callSid: data.call_id }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * @param {string} text
 * @param {{ force?: boolean, salah?: boolean, purpose?: 'salah', skipAutoRetry?: boolean, playOnce?: boolean, toNumber?: string, salahDate?: string, salahWaqt?: string }} opts
 *   - playOnce: message-delivery call — speak the FULL message exactly once, then hang up.
 *     No 200-char truncation, no "বিস্তারিত Telegram-এ" suffix (receiver may be a third
 *     party without the owner's Telegram), no double-play/<Say> repetition, and no
 *     ghost-connect auto-retry (a short message legitimately finishes in <12s).
 * @returns {Promise<{ok:boolean, callSid?:string, error?:string, skipped?:boolean}>}
 */
export async function makeTwilioCall(text, opts = {}) {
  const force = Boolean(opts.force)
  const playOnce = Boolean(opts.playOnce)
  const salah = Boolean(opts.salah || opts.purpose === 'salah')
  const salahDate = opts.salahDate
  const salahWaqt = opts.salahWaqt

  const lock = await isOwnerCallLocked()
  if (lock.locked) {
    console.log(`[twilio] call blocked — owner call lock until ${lock.until?.toISOString()} (${lock.source})`)
    return { ok: false, error: 'owner_call_locked', skipped: true }
  }

  // One-way carrier switch (Phase 5): route non-salah message/alert calls over the BD
  // number when ONE_WAY_CALL_PROVIDER=ngs. Salah stays on Twilio (its 3m/5m/5m retry +
  // confirm-block logic is Twilio-specific). Owner-call-lock above is already honoured.
  // Default OFF → unchanged Twilio behaviour.
  if (process.env.ONE_WAY_CALL_PROVIDER === 'ngs' && !salah) {
    const ngs = await makeNgsCall(text, opts)
    if (ngs.ok) return ngs
    console.warn('[ngs] one-way failed → falling back to Twilio:', ngs.error)
  }

  if (salah && salahDate && salahWaqt) {
    const salahBlock = await isSalahCallBlocked(salahDate, salahWaqt)
    if (salahBlock.blocked) {
      console.log(`[twilio/salah] call blocked — ${salahWaqt} confirmed for ${salahDate}`)
      return { ok: false, error: 'salah_confirmed', skipped: true }
    }
  }

  const accountSid  = process.env.TWILIO_ACCOUNT_SID
  const authToken   = process.env.TWILIO_AUTH_TOKEN
  const { fromNumber, dedicatedSalah } = resolveTwilioFromNumber(opts)
  const toNumber    = opts.toNumber ?? process.env.TWILIO_TO_NUMBER
  const publicBase  = getTwilioPublicBase()
  const appUrl      = (process.env.APP_URL ?? '').replace(/\/$/, '')

  if (!accountSid || !authToken || !fromNumber || !toNumber) {
    return { ok: false, error: 'Twilio env vars missing (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER / destination number)' }
  }

  if (salah && dedicatedSalah) {
    console.log('[twilio/salah] outbound from dedicated TWILIO_SALAH_FROM_NUMBER')
  }

  const now = Date.now()
  const bypassCooldown = salah || force
  if (!bypassCooldown && now - lastCallPlacedAt < MIN_CALL_GAP_MS) {
    return { ok: false, error: 'call_cooldown', skipped: true }
  }

  let speechText
  if (playOnce) {
    // Full message, safety-bounded only — no Telegram suffix for third-party receivers.
    speechText = text.slice(0, MESSAGE_CALL_TEXT_LIMIT)
  } else {
    speechText = text.slice(0, CALL_TEXT_LIMIT)
    if (text.length > CALL_TEXT_LIMIT) speechText += '... বিস্তারিত Telegram-এ।'
  }

  try {
    const mp3Buffer = await synthesizeCallAudio(speechText, opts)
    const wavBuffer = await mp3ToTelephonyWav(mp3Buffer)

    const supabase = getSupabase()
    const storagePath = `calls/call_${Date.now()}.wav`
    const { error: uploadErr } = await supabase.storage
      .from('agent-files')
      .upload(storagePath, wavBuffer, { contentType: 'audio/wav', upsert: true })
    if (uploadErr) throw new Error(`Supabase upload: ${uploadErr.message}`)

    const audioUrl = buildProxiedAudioUrl(publicBase, storagePath)
    const twimlUrl = buildTwimlCallbackUrl(publicBase, audioUrl, speechText, { once: playOnce })
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
      units: { callSid: result.callSid, estimated_seconds: 60, salah, dedicatedSalah },
      costUsd: calcTwilioCostUsd(60),
      jobId: result.callSid,
      dedupKey: `twilio:${result.callSid}`,
    })

    // playOnce implies skipAutoRetry: a short message-delivery call legitimately
    // completes in <12s, which would look like a ghost connect and trigger a retry.
    if (!opts.skipAutoRetry && !playOnce) {
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
        void scheduleSalahCallRetries({
          initialCallSid: result.callSid,
          ...retryCtx,
          salahDate,
          salahWaqt,
        })
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
      const internalToken = process.env.AGENT_INTERNAL_TOKEN
      const headers = internalToken ? { Authorization: `Bearer ${internalToken}` } : {}
      const res = await fetch(`${appUrl}/api/twilio/call-status`, { method: 'POST', body, headers })
      console.log(`[twilio] polled call result ${callSid} → ${call.status} (${call.duration ?? 0}s) HTTP ${res.status}`)
      return
    } catch (err) {
      console.warn('[twilio] poll call result failed:', err.message)
      return
    }
  }
  console.warn(`[twilio] poll timeout for call ${callSid}`)
}
