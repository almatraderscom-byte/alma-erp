/**
 * Twilio Tier-3 escalation call.
 *
 * Flow:
 *  1. Synthesize text via Google TTS (MP3)
 *  2. Convert to 8 kHz mono WAV via ffmpeg (fixes voice-cutting bug on telephony)
 *  3. Upload WAV to Supabase agent-files as a signed public URL (TTL 10 min)
 *  4. Place Twilio call with TwiML <Play> pointing at the signed URL
 *
 * Message cap: first ~20 seconds of speech (~200 chars Bangla). Anything longer
 * is truncated with "বিস্তারিত Telegram-এ।"
 */

import { createClient } from '@supabase/supabase-js'
import { synthesizeSpeech, mp3ToTelephonyWav } from '../tts.mjs'

const CALL_TEXT_LIMIT = 200

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  )
}

/**
 * @param {string} text
 * @returns {Promise<{ok:boolean, callSid?:string, error?:string}>}
 */
export async function makeTwilioCall(text) {
  const accountSid  = process.env.TWILIO_ACCOUNT_SID
  const authToken   = process.env.TWILIO_AUTH_TOKEN
  const fromNumber  = process.env.TWILIO_FROM_NUMBER
  const toNumber    = process.env.TWILIO_TO_NUMBER

  if (!accountSid || !authToken || !fromNumber || !toNumber) {
    return { ok: false, error: 'Twilio env vars missing (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER / TWILIO_TO_NUMBER)' }
  }

  // Truncate speech to ~20s cap and append redirect notice
  let speechText = text.slice(0, CALL_TEXT_LIMIT)
  if (text.length > CALL_TEXT_LIMIT) speechText += '... বিস্তারিত Telegram-এ।'

  try {
    // TTS → MP3
    const mp3Buffer = await synthesizeSpeech(speechText, CALL_TEXT_LIMIT + 20)

    // MP3 → 8 kHz mono WAV
    const wavBuffer = await mp3ToTelephonyWav(mp3Buffer)

    // Upload to Supabase with 10-minute signed URL
    const supabase = getSupabase()
    const storagePath = `calls/call_${Date.now()}.wav`
    const { error: uploadErr } = await supabase
      .storage
      .from('agent-files')
      .upload(storagePath, wavBuffer, { contentType: 'audio/wav', upsert: true })
    if (uploadErr) throw new Error(`Supabase upload: ${uploadErr.message}`)

    const { data: signedData, error: signErr } = await supabase
      .storage
      .from('agent-files')
      .createSignedUrl(storagePath, 600) // 10 min
    if (signErr || !signedData?.signedUrl) throw new Error(`Supabase sign: ${signErr?.message}`)

    const audioUrl = signedData.signedUrl

    // Twilio REST API call
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${audioUrl}</Play></Response>`
    const twimlBase64 = Buffer.from(twiml).toString('base64')
    // Use TwiML URL via data URI isn't supported — we need a TwiML endpoint.
    // Use Twilio's hosted TwiML bin approach via /Calls with Url pointing to a TwiML endpoint.
    // Since we can't host a dynamic endpoint easily, we embed TwiML inline via the twiml param.
    const body = new URLSearchParams({
      To:    toNumber,
      From:  fromNumber,
      Twiml: twiml,
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
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
