/**
 * FCM v1 call sender — the Android half of WhatsApp-style incoming calls.
 *
 * Sends a high-priority DATA-only message so the app's FirebaseMessagingService
 * runs even when the app is backgrounded/killed, and turns it into a
 * full-screen-intent incoming-call notification. Data-only (no `notification`
 * block) is deliberate: it guarantees the service — not the system tray — gets
 * the message, which is required to raise the call UI.
 *
 * Config (Vercel env — owner supplies from Firebase Console → Project Settings →
 * Service accounts → Generate new private key):
 *   FCM_SERVICE_ACCOUNT   the service-account JSON (client_email, private_key,
 *                         project_id). \n-escaped private_key is fine.
 *
 * Fail-open: unconfigured or a per-token error never throws to the caller.
 */
import { createSign } from 'node:crypto'
import { disableCallToken } from '@/agent/lib/call-push'

type SaCreds = { client_email: string; private_key: string; project_id: string }

function getCreds(): SaCreds | null {
  const raw = process.env.FCM_SERVICE_ACCOUNT?.trim()
  if (!raw) return null
  try {
    const c = JSON.parse(raw) as SaCreds
    if (!c.client_email || !c.private_key || !c.project_id) return null
    // Vercel env may escape the newlines inside the PEM.
    if (c.private_key.includes('\\n')) c.private_key = c.private_key.replace(/\\n/g, '\n')
    return c
  } catch (err) {
    console.warn('[fcm-call] FCM_SERVICE_ACCOUNT parse failed:', (err as Error)?.message)
    return null
  }
}

export function fcmCallConfigured(): boolean {
  return getCreds() !== null
}

let cachedToken: { token: string; exp: number } | null = null

async function accessToken(creds: SaCreds): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000)
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token
  try {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        iss: creds.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    ).toString('base64url')
    const sign = createSign('RSA-SHA256')
    sign.update(`${header}.${payload}`)
    const jwt = `${header}.${payload}.${sign.sign(creds.private_key, 'base64url')}`

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      console.error('[fcm-call] token exchange failed:', (await res.text()).slice(0, 160))
      return null
    }
    const data = (await res.json()) as { access_token: string; expires_in: number }
    cachedToken = { token: data.access_token, exp: now + (data.expires_in || 3600) }
    return data.access_token
  } catch (err) {
    console.error('[fcm-call] access token failed:', (err as Error)?.message)
    return null
  }
}

export type FcmCallPayload = {
  type: 'office_call'
  broadcastId: string
  channel: string
  caller: string
  /** 'ring' (default) shows a full-screen incoming call; 'cancel' dismisses it. */
  event?: 'ring' | 'cancel'
}

type SendResult = { token: string; ok: boolean; status?: number; reason?: string }

/** Send a high-priority data-only call message to every Android FCM token. */
export async function sendFcmCall(tokens: string[], payload: FcmCallPayload): Promise<SendResult[]> {
  const uniq = [...new Set(tokens.filter(Boolean))]
  if (uniq.length === 0) return []
  const creds = getCreds()
  if (!creds) return uniq.map((t) => ({ token: t, ok: false, reason: 'fcm_unconfigured' }))
  const token = await accessToken(creds)
  if (!token) return uniq.map((t) => ({ token: t, ok: false, reason: 'fcm_auth_failed' }))

  const url = `https://fcm.googleapis.com/v1/projects/${creds.project_id}/messages:send`
  // All values must be strings in an FCM data payload.
  const data: Record<string, string> = {
    type: payload.type,
    broadcastId: payload.broadcastId,
    channel: payload.channel,
    caller: payload.caller,
    event: payload.event ?? 'ring',
  }

  const sendOne = async (deviceToken: string): Promise<SendResult> => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            data,
            android: { priority: 'high', ttl: '45s' },
          },
        }),
        signal: AbortSignal.timeout(8_000),
      })
      if (res.ok) return { token: deviceToken, ok: true, status: 200 }
      const text = await res.text().catch(() => '')
      // 404 UNREGISTERED / 400 invalid token → stop targeting it.
      if (res.status === 404 || /UNREGISTERED|InvalidRegistration/i.test(text)) {
        void disableCallToken('fcm', deviceToken)
      }
      return { token: deviceToken, ok: false, status: res.status, reason: text.slice(0, 160) }
    } catch (err) {
      return { token: deviceToken, ok: false, reason: (err as Error)?.message || 'send_failed' }
    }
  }

  return Promise.all(uniq.map(sendOne))
}
