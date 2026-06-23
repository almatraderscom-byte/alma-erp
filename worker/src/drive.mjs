/**
 * Google Drive helper — uploads Creative Studio originals into the OWNER's own
 * Google Drive via OAuth (not a service account).
 *
 * Why OAuth instead of the TTS service account: the owner's Google account is a
 * normal Gmail (no Workspace / Shared Drives). A service account has zero Drive
 * storage quota, so it cannot store files in a personal Drive. With OAuth we act
 * AS the owner — files are owned by him and count against his (large) Google One
 * quota. The owner connects once via /api/assistant/creative-studio/drive-auth;
 * the resulting refresh token is stored in agent_kv_settings and read here.
 *
 * Scope: drive.file (least privilege — the app only ever sees files it creates).
 * Folder layout inside the owner's My Drive:
 *   Creative Studio / YYYY / MM-Month /  (e.g. "Creative Studio/2026/06-June/")
 */

const TOKEN_KEY = 'studio_drive_oauth'
const ROOT_FOLDER_NAME = 'Creative Studio'
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// In-process cache for the folder hierarchy so repeat runs don't re-query Drive.
const folderCache = new Map() // key → folderId

function getClientCreds() {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID || ''
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET || ''
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

/**
 * Read the stored OAuth refresh token (+ connected email) from agent_kv_settings.
 * The kv value is a JSON string: { refresh_token, email, connected_at }.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<{ refreshToken: string, email: string } | null>}
 */
export async function getDriveConnection(supabase) {
  const { data } = await supabase
    .from('agent_kv_settings')
    .select('value')
    .eq('key', TOKEN_KEY)
    .maybeSingle()
  if (!data?.value) return null
  try {
    const parsed = JSON.parse(data.value)
    if (!parsed?.refresh_token) return null
    return { refreshToken: parsed.refresh_token, email: parsed.email ?? '' }
  } catch {
    return null
  }
}

/** True when client creds AND a stored refresh token are both present. */
export async function isDriveConfigured(supabase) {
  if (!getClientCreds()) return false
  const conn = await getDriveConnection(supabase)
  return Boolean(conn)
}

/**
 * Exchange the refresh token for a short-lived access token.
 * @param {string} refreshToken
 * @returns {Promise<string>}
 */
export async function getDriveAccessToken(refreshToken) {
  const creds = getClientCreds()
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
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Drive token refresh failed: ${await res.text()}`)
  const data = await res.json()
  if (!data.access_token) throw new Error('Drive token refresh returned no access_token')
  return data.access_token
}

/**
 * Find a child folder by name within a parent, creating it if absent.
 * Operates in the owner's personal My Drive (no Shared Drive params).
 */
async function ensureFolder(token, name, parentId) {
  const cacheKey = `${parentId}/${name}`
  if (folderCache.has(cacheKey)) return folderCache.get(cacheKey)

  const safeName = name.replace(/'/g, "\\'")
  const q = [
    `name='${safeName}'`,
    "mimeType='application/vnd.google-apps.folder'",
    `'${parentId}' in parents`,
    'trashed=false',
  ].join(' and ')

  const searchUrl = new URL('https://www.googleapis.com/drive/v3/files')
  searchUrl.searchParams.set('q', q)
  searchUrl.searchParams.set('fields', 'files(id,name)')
  searchUrl.searchParams.set('spaces', 'drive')

  const searchRes = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!searchRes.ok) throw new Error(`Drive folder search failed (${name}): ${await searchRes.text()}`)
  const searchData = await searchRes.json()
  const found = searchData.files?.[0]?.id
  if (found) {
    folderCache.set(cacheKey, found)
    return found
  }

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!createRes.ok) throw new Error(`Drive folder create failed (${name}): ${await createRes.text()}`)
  const created = await createRes.json()
  folderCache.set(cacheKey, created.id)
  return created.id
}

/**
 * Resolve (creating as needed) the month folder for a given date:
 *   Creative Studio / YYYY / MM-Month
 */
async function ensureMonthFolder(token, date = new Date()) {
  // Use Asia/Dhaka (UTC+6) so month boundaries match the owner's day.
  const dhaka = new Date(date.getTime() + 6 * 60 * 60 * 1000)
  const year = String(dhaka.getUTCFullYear())
  const monthIdx = dhaka.getUTCMonth()
  const monthLabel = `${String(monthIdx + 1).padStart(2, '0')}-${MONTH_NAMES[monthIdx]}`

  const rootId = await ensureFolder(token, ROOT_FOLDER_NAME, 'root')
  const yearId = await ensureFolder(token, year, rootId)
  const monthId = await ensureFolder(token, monthLabel, yearId)
  return monthId
}

/**
 * Upload a buffer to the month folder via a multipart Drive upload.
 * @param {object} args
 * @param {string} args.token        OAuth access token
 * @param {Buffer} args.buffer
 * @param {string} args.name         Filename to store in Drive
 * @param {string} args.contentType  e.g. 'image/png', 'video/mp4'
 * @param {Date} [args.date]         Date used to pick the month folder
 * @returns {Promise<{ fileId: string, webViewLink: string, folderId: string }>}
 */
export async function uploadToDrive({ token, buffer, name, contentType, date }) {
  const folderId = await ensureMonthFolder(token, date)

  const boundary = `alma-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const metadata = { name, parents: [folderId] }
  const preamble =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  const epilogue = `\r\n--${boundary}--`

  const body = Buffer.concat([
    Buffer.from(preamble, 'utf8'),
    buffer,
    Buffer.from(epilogue, 'utf8'),
  ])

  const url =
    'https://www.googleapis.com/upload/drive/v3/files' +
    '?uploadType=multipart&fields=id,webViewLink'

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`Drive upload failed (${name}): ${await res.text()}`)
  const data = await res.json()
  if (!data.id) throw new Error(`Drive upload returned no file id (${name})`)

  return { fileId: data.id, webViewLink: data.webViewLink ?? '', folderId }
}

/**
 * Verify a Drive file exists and is non-trashed (used before deleting the
 * Supabase copy — never delete the only copy).
 * @param {string} token
 * @param {string} fileId
 * @returns {Promise<boolean>}
 */
export async function verifyDriveFile(token, fileId) {
  if (!token || !fileId) return false
  try {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`)
    url.searchParams.set('fields', 'id,trashed,size')
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return false
    const data = await res.json()
    return Boolean(data.id) && data.trashed !== true
  } catch (err) {
    console.warn('[drive] verifyDriveFile failed:', err.message)
    return false
  }
}
