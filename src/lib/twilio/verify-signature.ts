/**
 * Twilio request signature verification.
 *
 * Twilio signs every webhook request with HMAC-SHA1 of:
 *   url + sorted POST body params (or just url for GET)
 *
 * Spec: https://www.twilio.com/docs/usage/security#validating-requests
 *
 * We MUST verify the signature on:
 *  - /api/twilio/twiml/salah-call (GET — Twilio fetches TwiML)
 *  - /api/twilio/call-status      (POST — Twilio status callback)
 *
 * Without this, anyone with the public Vercel URL can:
 *  - Trigger fake "call missed → retry" flows
 *  - Drive arbitrary outbound TwiML <Say>/<Play> content
 */

import crypto from 'node:crypto'
import type { NextRequest } from 'next/server'

const AUTH_TOKEN = () => process.env.TWILIO_AUTH_TOKEN ?? ''

/**
 * Compute the Twilio signature.
 *
 * @param url   Full request URL Twilio sees (must match `req.url` after proxy normalisation)
 * @param body  For POST form-encoded requests, the parsed param map; empty object for GET
 */
export function computeTwilioSignature(url: string, body: Record<string, string>): string {
  const authToken = AUTH_TOKEN()
  if (!authToken) return ''
  let data = url
  for (const key of Object.keys(body).sort()) {
    data += key + body[key]
  }
  return crypto.createHmac('sha1', authToken).update(data).digest('base64')
}

/**
 * Verify a Twilio webhook request.
 *
 * @param req      Incoming NextRequest
 * @param body     For POST: form params object. For GET: pass {}
 * @returns        true if signature matches; false otherwise (or if no token configured in non-prod)
 */
export function verifyTwilioRequest(req: NextRequest, body: Record<string, string>): boolean {
  const provided = req.headers.get('x-twilio-signature') ?? ''
  if (!provided) return false

  if (!AUTH_TOKEN()) {
    if (process.env.NODE_ENV === 'production') return false
    return true
  }

  const url = `${req.nextUrl.origin}${req.nextUrl.pathname}${req.nextUrl.search}`
  const expected = computeTwilioSignature(url, body)
  if (!expected) return false

  if (provided.length !== expected.length) return false
  let mismatch = 0
  for (let i = 0; i < expected.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return mismatch === 0
}

/**
 * Form-encoded body → param map (for POST signature verification).
 */
export function formDataToParams(form: FormData): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of form.entries()) {
    out[k] = typeof v === 'string' ? v : ''
  }
  return out
}
