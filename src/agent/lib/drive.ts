/**
 * Google Drive access for the Next.js app — reuses the GOOGLE_TTS_CREDENTIALS
 * service account (same one used by TTS) with the Drive scope.
 *
 * Used by the Creative Studio gallery proxy to stream archived originals back
 * to the owner after the Supabase copy has been cleaned up. The worker
 * (worker/src/drive.mjs) owns uploads; this side only reads.
 */
import { createSign } from 'crypto'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'

function getCredentials(): { client_email: string; private_key: string } | null {
  const raw = process.env.GOOGLE_TTS_CREDENTIALS
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (err) {
    console.warn('[drive] GOOGLE_TTS_CREDENTIALS parse failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export function isDriveConfigured(): boolean {
  return Boolean(getCredentials())
}

async function getAccessToken(creds: { client_email: string; private_key: string }): Promise<string> {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: DRIVE_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url')

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
  if (!res.ok) throw new Error(`Google Drive auth failed: ${await res.text()}`)
  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

/**
 * Stream a Drive file's bytes by id (Shared-Drive aware). Returns the upstream
 * Response so the caller can pipe the body and headers straight through.
 */
export async function fetchDriveFile(fileId: string): Promise<Response | null> {
  const creds = getCredentials()
  if (!creds || !fileId) return null
  const accessToken = await getAccessToken(creds)
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`)
  url.searchParams.set('alt', 'media')
  url.searchParams.set('supportsAllDrives', 'true')
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    console.warn('[drive] fetchDriveFile failed:', res.status, await res.text().catch(() => ''))
    return null
  }
  return res
}
