// Imou (Lechange) Open Platform client — minimal, server-side only.
// Used by the staff idle-detection pilot to pull a still snapshot from an office
// camera. Auth is appId + appSecret (owner created a developer app on
// open.imoulife.com); the access token is short-lived and cached in-process.
//
// Sign scheme (per Imou dev spec, confirmed against the official imouapi lib):
//   sign = md5(`time:${time},nonce:${nonce},appSecret:${appSecret}`)
// Every request body is { system:{ver,sign,appId,time,nonce}, params, id }.
//
// Region base: Bangladesh → Asia/Singapore data center by default. Override with
// IMOU_API_BASE if the owner's account lives in another region.
import crypto from 'crypto'

const DEFAULT_BASE = 'https://openapi-sg.easy4ip.com/openapi'

function base(): string {
  return (process.env.IMOU_API_BASE ?? '').replace(/\/$/, '') || DEFAULT_BASE
}

interface ImouEnvelope<T> {
  result?: { code?: string; msg?: string; data?: T }
  id?: string
}

function buildBody(appId: string, appSecret: string, params: Record<string, unknown>) {
  const time = Math.floor(Date.now() / 1000)
  const nonce = crypto.randomUUID()
  const sign = crypto
    .createHash('md5')
    .update(`time:${time},nonce:${nonce},appSecret:${appSecret}`)
    .digest('hex')
  return {
    system: { ver: '1.0', sign, appId, time, nonce },
    params,
    id: crypto.randomUUID(),
  }
}

async function call<T>(endpoint: string, params: Record<string, unknown>): Promise<T> {
  const appId = process.env.IMOU_APP_ID
  const appSecret = process.env.IMOU_APP_SECRET
  if (!appId || !appSecret) throw new Error('IMOU_APP_ID / IMOU_APP_SECRET not configured')

  const res = await fetch(`${base()}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBody(appId, appSecret, params)),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Imou ${endpoint} HTTP ${res.status}`)
  const json = (await res.json()) as ImouEnvelope<T>
  if (json.result?.code !== '0') {
    throw new Error(`Imou ${endpoint} error ${json.result?.code}: ${json.result?.msg ?? 'unknown'}`)
  }
  if (json.result?.data === undefined) throw new Error(`Imou ${endpoint} returned no data`)
  return json.result.data
}

// Token is valid ~3 days; cache in-process so a warm Lambda reuses it. Refresh a
// little early to avoid edge-of-expiry failures.
let tokenCache: { token: string; expiresAt: number } | null = null

async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token
  const data = await call<{ accessToken: string; expireTime: number }>('accessToken', {})
  const ttlMs = Math.max((data.expireTime ?? 3600) * 1000, 60_000)
  tokenCache = { token: data.accessToken, expiresAt: Date.now() + ttlMs }
  return data.accessToken
}

export interface ImouCameraChannel {
  deviceId: string
  channelId: string
  channelName: string
}

/** List cameras bound to the developer app (for setup / diagnostics). */
export async function listImouCameras(): Promise<ImouCameraChannel[]> {
  const token = await getAccessToken()
  const data = await call<{
    deviceList?: Array<{ deviceId: string; channels?: Array<{ channelId: string; channelName: string }> }>
  }>('deviceBaseList', { token, bindId: -1, limit: 50, type: 'bindAndShare', needApInfo: false })

  const out: ImouCameraChannel[] = []
  for (const d of data.deviceList ?? []) {
    for (const c of d.channels ?? []) {
      out.push({ deviceId: d.deviceId, channelId: c.channelId, channelName: c.channelName })
    }
  }
  return out
}

export interface ImouSnapshot {
  /** Temporary (Aliyun OSS signed) URL to the JPEG. Expires within the hour. */
  url: string
  capturedAt: Date
  deviceId: string
}

/**
 * Capture a fresh still snapshot from a device. Returns a short-lived signed URL.
 * channelId defaults to '0' (single-lens cameras like the Ranger 2 Pro).
 */
export async function captureImouSnapshot(
  deviceId = process.env.IMOU_DEVICE_ID ?? '',
  channelId = '0',
): Promise<ImouSnapshot> {
  if (!deviceId) throw new Error('IMOU_DEVICE_ID not configured and no deviceId passed')
  const token = await getAccessToken()
  const data = await call<{ url: string }>('setDeviceSnapEnhanced', { token, deviceId, channelId })
  if (!data.url) throw new Error('Imou snapshot returned no url')
  return { url: data.url, capturedAt: new Date(), deviceId }
}

/** Download a snapshot URL to a base64 string + mime, for vision analysis. */
export async function downloadSnapshot(url: string): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`Snapshot download HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const mimeType = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
  return { base64: buf.toString('base64'), mimeType }
}
