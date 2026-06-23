/**
 * Google Drive access for the Next.js app — OAuth on the OWNER's own account.
 *
 * The owner connects once (see the drive-auth routes); the refresh token is
 * stored in agent_kv_settings under `studio_drive_oauth`. The worker owns
 * uploads + cleanup; this side only reads (gallery proxy) and stores the token
 * during the OAuth callback.
 *
 * Scope: drive.file (the app only ever sees files it created).
 */
import { prisma } from '@/lib/prisma'

export const DRIVE_OAUTH_KEY = 'studio_drive_oauth'
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

type DriveConnection = { refresh_token: string; email?: string; connected_at?: string }

export function getDriveClientCreds(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? ''
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

/** The registered OAuth redirect URI — must match the GCP OAuth client exactly. */
export function getDriveRedirectUri(): string {
  const base = (process.env.NEXTAUTH_URL ?? process.env.APP_URL ?? '').replace(/\/$/, '')
  return `${base}/api/assistant/creative-studio/drive-auth/callback`
}

export async function getDriveConnection(): Promise<DriveConnection | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const row = await db.agentKvSetting.findUnique({
    where: { key: DRIVE_OAUTH_KEY },
    select: { value: true },
  })
  if (!row?.value) return null
  try {
    const parsed = JSON.parse(row.value) as DriveConnection
    return parsed?.refresh_token ? parsed : null
  } catch {
    return null
  }
}

export async function saveDriveConnection(conn: DriveConnection): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const value = JSON.stringify(conn)
  await db.agentKvSetting.upsert({
    where: { key: DRIVE_OAUTH_KEY },
    create: { key: DRIVE_OAUTH_KEY, value },
    update: { value },
  })
}

export async function clearDriveConnection(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  await db.agentKvSetting.deleteMany({ where: { key: DRIVE_OAUTH_KEY } })
}

/** True when client creds AND a stored refresh token are both present. */
export async function isDriveConnected(): Promise<boolean> {
  if (!getDriveClientCreds()) return false
  return Boolean(await getDriveConnection())
}

async function getAccessToken(refreshToken: string): Promise<string> {
  const creds = getDriveClientCreds()
  if (!creds) throw new Error('GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET not set')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Drive token refresh failed: ${await res.text()}`)
  const data = (await res.json()) as { access_token?: string }
  if (!data.access_token) throw new Error('Drive token refresh returned no access_token')
  return data.access_token
}

/**
 * Exchange an OAuth authorization code for tokens (callback route).
 * @returns refresh_token + the connected account email (best effort).
 */
export async function exchangeCodeForTokens(code: string): Promise<DriveConnection> {
  const creds = getDriveClientCreds()
  if (!creds) throw new Error('GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET not set')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: getDriveRedirectUri(),
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Drive code exchange failed: ${await res.text()}`)
  const data = (await res.json()) as { refresh_token?: string; access_token?: string }
  if (!data.refresh_token) {
    throw new Error('No refresh_token returned — re-consent with prompt=consent + access_type=offline')
  }

  // Best-effort: fetch the connected account email so the UI can show it.
  let email = ''
  try {
    if (data.access_token) {
      const me = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${data.access_token}` },
        signal: AbortSignal.timeout(8_000),
      })
      if (me.ok) email = ((await me.json()) as { email?: string }).email ?? ''
    }
  } catch {
    // ignore — email is cosmetic
  }

  return { refresh_token: data.refresh_token, email, connected_at: new Date().toISOString() }
}

/**
 * Stream a Drive file's bytes by id (owner's personal Drive). Returns the
 * upstream Response so the caller can pipe the body + headers straight through.
 */
export async function fetchDriveFile(fileId: string): Promise<Response | null> {
  if (!fileId) return null
  const conn = await getDriveConnection()
  if (!conn) return null
  const accessToken = await getAccessToken(conn.refresh_token)
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`)
  url.searchParams.set('alt', 'media')
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
