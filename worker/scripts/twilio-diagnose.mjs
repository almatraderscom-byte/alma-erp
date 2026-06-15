#!/usr/bin/env node
/**
 * Diagnose Twilio call delivery — status, recent calls, place test call.
 * Usage: cd worker && node scripts/twilio-diagnose.mjs [--call]
 */
import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { makeTwilioCall } from '../src/notify/twilio-call.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dir, '../.env') })

const sid = process.env.TWILIO_ACCOUNT_SID
const token = process.env.TWILIO_AUTH_TOKEN
const auth = Buffer.from(`${sid}:${token}`).toString('base64')

function maskPhone(p) {
  if (!p) return '(missing)'
  return p.replace(/\d(?=\d{4})/g, '*')
}

async function fetchCall(callSid) {
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${callSid}.json`,
    { headers: { Authorization: `Basic ${auth}` } },
  )
  return res.json()
}

async function listRecent() {
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json?PageSize=10`,
    { headers: { Authorization: `Basic ${auth}` } },
  )
  return res.json()
}

console.log('FROM:', maskPhone(process.env.TWILIO_FROM_NUMBER))
console.log('SALAH FROM:', maskPhone(process.env.TWILIO_SALAH_FROM_NUMBER))
console.log('TO:  ', maskPhone(process.env.TWILIO_TO_NUMBER))

const recent = await listRecent()
console.log('\n--- Recent Twilio calls ---')
for (const c of recent.calls ?? []) {
  console.log(
    c.date_created,
    '|',
    c.status,
    '|',
    maskPhone(c.to),
    '|',
    'dur=' + (c.duration ?? '0'),
    c.error_message ? `| ERR: ${c.error_message}` : '',
  )
}

const placeCall = process.argv.includes('--call')
const forceCall = process.argv.includes('--force')
const salahCall = process.argv.includes('--salah')
if (placeCall) {
  if (!process.env.APP_URL) {
    console.error('APP_URL required for TwiML proxy (e.g. https://alma-erp-six.vercel.app)')
    process.exit(1)
  }
  console.log('APP_URL:', process.env.APP_URL)
  const mode = salahCall ? 'salah (dedicated FROM if set)' : 'general'
  console.log(`\n--- Placing test call (${mode}) ---`)
  const result = await makeTwilioCall(
    salahCall
      ? 'আস্সালামু আলাইকুম স্যার। এটি নামাজ রিমাইন্ডার টেস্ট কল। দয়া করে ফোন ধরুন।'
      : 'আস্সালামু আলাইকুম স্যার। এটি ALMA টেস্ট কল। দয়া করে ফোন ধরুন।',
    { force: forceCall, salah: salahCall, purpose: salahCall ? 'salah' : undefined },
  )
  console.log('place:', JSON.stringify(result))
  if (result.callSid) {
    await new Promise((r) => setTimeout(r, 22000))
    const detail = await fetchCall(result.callSid)
    console.log('\n--- Call detail after 22s (retry window) ---')
    console.log(JSON.stringify({
      sid: detail.sid,
      status: detail.status,
      to: maskPhone(detail.to),
      from: maskPhone(detail.from),
      from_expected: salahCall
        ? maskPhone(process.env.TWILIO_SALAH_FROM_NUMBER || process.env.TWILIO_FROM_NUMBER)
        : maskPhone(process.env.TWILIO_FROM_NUMBER),
      duration: detail.duration,
      error_code: detail.error_code,
      error_message: detail.error_message,
      note: Number(detail.duration) > 0 && Number(detail.duration) < 12
        ? 'ghost-connect — say-only retry may have fired'
        : undefined,
    }, null, 2))
  }
}
