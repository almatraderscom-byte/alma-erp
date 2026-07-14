/**
 * APNs VoIP push sender — the iOS half of WhatsApp-style incoming calls.
 *
 * A VoIP push (PushKit) is the ONLY way iOS lets a backgrounded/killed app show
 * a native full-screen incoming call (via CallKit). OneSignal cannot send these,
 * so we talk to APNs directly over HTTP/2 with a token (.p8) auth key.
 *
 * Config (Vercel env — owner supplies from Apple Developer → Keys → an APNs Auth
 * Key with "Apple Push Notifications service" enabled):
 *   APNS_AUTH_KEY   the .p8 file contents (PEM). \n-escaped is fine.
 *   APNS_KEY_ID     the 10-char Key ID of that .p8
 *   APNS_TEAM_ID    the 10-char Apple Team ID
 *   APNS_BUNDLE_ID  app bundle (default com.almatraders.erp) → topic <bundle>.voip
 *   APNS_PRODUCTION 'true' → api.push.apple.com (TestFlight/App Store); else sandbox
 *
 * Everything is fail-open: unconfigured or a per-token error never throws to the
 * caller (a call must still ring the foreground app via its poll). Stale tokens
 * (410 / BadDeviceToken / Unregistered) are disabled so we stop targeting them.
 */
import http2 from 'node:http2'
import { createPrivateKey, sign as cryptoSign } from 'node:crypto'
import { disableCallToken } from '@/agent/lib/call-push'

function b64url(s: string): string {
  return Buffer.from(s).toString('base64url')
}

export function apnsVoipConfigured(): boolean {
  return Boolean(
    process.env.APNS_AUTH_KEY?.trim() && process.env.APNS_KEY_ID?.trim() && process.env.APNS_TEAM_ID?.trim(),
  )
}

// APNs allows reusing one auth JWT for up to 1h (and forbids minting more than
// ~once per 20 min). Cache it in module scope and refresh every ~50 min.
let cachedJwt: { token: string; at: number } | null = null

function apnsJwt(): string | null {
  const keyRaw = process.env.APNS_AUTH_KEY?.trim()
  const keyId = process.env.APNS_KEY_ID?.trim()
  const teamId = process.env.APNS_TEAM_ID?.trim()
  if (!keyRaw || !keyId || !teamId) return null

  const now = Date.now()
  if (cachedJwt && now - cachedJwt.at < 50 * 60_000) return cachedJwt.token

  try {
    // Vercel env may store the PEM with escaped newlines.
    const pem = keyRaw.includes('\\n') ? keyRaw.replace(/\\n/g, '\n') : keyRaw
    const key = createPrivateKey(pem)
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }))
    const payload = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }))
    const signingInput = `${header}.${payload}`
    // ieee-p1363 (r||s) is the JWS-required ECDSA encoding; the default is DER.
    const sig = cryptoSign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' })
    const token = `${signingInput}.${sig.toString('base64url')}`
    cachedJwt = { token, at: now }
    return token
  } catch (err) {
    console.error('[apns-voip] JWT sign failed:', (err as Error)?.message)
    return null
  }
}

export type VoipCallPayload = {
  type: 'office_call'
  broadcastId: string
  channel: string
  caller: string
}

type SendResult = { token: string; ok: boolean; status?: number; reason?: string }

/**
 * Send a VoIP push to every iOS device token. Opens ONE HTTP/2 connection for
 * the batch. Returns per-token results; disables tokens APNs rejects as stale.
 */
export async function sendVoipCall(tokens: string[], payload: VoipCallPayload): Promise<SendResult[]> {
  const uniq = [...new Set(tokens.filter(Boolean))]
  if (uniq.length === 0) return []
  const jwt = apnsJwt()
  if (!jwt) return uniq.map((t) => ({ token: t, ok: false, reason: 'apns_unconfigured' }))

  const bundle = process.env.APNS_BUNDLE_ID?.trim() || 'com.almatraders.erp'
  const topic = `${bundle}.voip`
  const host = process.env.APNS_PRODUCTION === 'true' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com'

  // The VoIP payload is fully custom (no user-facing aps alert needed) — the
  // PushKit delegate reads these keys and reports the call to CallKit.
  const body = JSON.stringify({ aps: {}, ...payload })

  let client: http2.ClientHttp2Session
  try {
    client = http2.connect(`https://${host}`)
  } catch (err) {
    return uniq.map((t) => ({ token: t, ok: false, reason: (err as Error)?.message || 'connect_failed' }))
  }

  const sendOne = (deviceToken: string) =>
    new Promise<SendResult>((resolve) => {
      let status = 0
      let data = ''
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': topic,
        'apns-push-type': 'voip',
        'apns-priority': '10',
        'apns-expiration': '0', // deliver now or drop — a ring is worthless late
        'content-type': 'application/json',
      })
      req.setEncoding('utf8')
      req.on('response', (h) => {
        status = Number(h[':status']) || 0
      })
      req.on('data', (c) => {
        data += c
      })
      req.on('end', () => {
        const ok = status === 200
        let reason: string | undefined
        if (!ok) {
          try {
            reason = (JSON.parse(data || '{}') as { reason?: string }).reason
          } catch {
            reason = data?.slice(0, 120)
          }
          if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') {
            void disableCallToken('voip', deviceToken)
          }
        }
        resolve({ token: deviceToken, ok, status, reason })
      })
      req.on('error', (err) => resolve({ token: deviceToken, ok: false, reason: err.message }))
      req.setTimeout(8_000, () => {
        req.close()
        resolve({ token: deviceToken, ok: false, reason: 'timeout' })
      })
      req.end(body)
    })

  try {
    return await Promise.all(uniq.map(sendOne))
  } catch (err) {
    return uniq.map((t) => ({ token: t, ok: false, reason: (err as Error)?.message || 'send_failed' }))
  } finally {
    try {
      client.close()
    } catch {
      /* already closed */
    }
  }
}
