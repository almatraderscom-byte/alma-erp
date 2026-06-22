/**
 * Google Drive helper — reuses the GOOGLE_TTS_CREDENTIALS service account.
 *
 * The same service account that powers Google TTS is reused for Drive: we just
 * mint a token with the Drive scope instead of the cloud-platform scope. No new
 * credential is needed.
 *
 * Workspace quota note: a service account's *own* My Drive has no usable storage
 * quota, so files MUST be uploaded into a **Shared Drive** where the service
 * account is a Content Manager. The Shared Drive id is provided via STUDIO_DRIVE_ID.
 *
 * Folder layout inside the Shared Drive:
 *   Creative Studio / YYYY / MM-Month /  (e.g. "Creative Studio/2026/06-June/")
 */

import { createSign } from 'crypto'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'
const ROOT_FOLDER_NAME = 'Creative Studio'
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// In-process cache for the folder hierarchy so repeat runs don't re-query Drive.
const folderCache = new Map() // key → folderId

function getCredentials() {
  const raw = process.env.GOOGLE_TTS_CREDENTIALS
  if (!raw) return null
  try { return JSON.parse(raw) } catch (err) {
    console.warn('[drive] GOOGLE_TTS_CREDENTIALS JSON parse failed:', err.message)
    return null
  }
}

function getDriveId() {
  return process.env.STUDIO_DRIVE_ID || ''
}

/**
 * True when Drive archiving is fully configured (credentials + Shared Drive id).
 */
export function isDriveConfigured() {
  return Boolean(getCredentials() && getDriveId())
}

async function getAccessToken(creds) {
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
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Google Drive auth failed: ${await res.text()}`)
  const data = await res.json()
  return data.access_token
}

/**
 * Find a child folder by name within a parent, creating it if absent.
 * All calls are Shared-Drive aware (supportsAllDrives + corpora=drive).
 */
async function ensureFolder(token, driveId, name, parentId) {
  const cacheKey = `${parentId}/${name}`
  if (folderCache.has(cacheKey)) return folderCache.get(cacheKey)

  // Escape single quotes in the folder name for the Drive query language.
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
  searchUrl.searchParams.set('supportsAllDrives', 'true')
  searchUrl.searchParams.set('includeItemsFromAllDrives', 'true')
  searchUrl.searchParams.set('corpora', 'drive')
  searchUrl.searchParams.set('driveId', driveId)

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

  // Create it.
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
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
 * @param {string} token
 * @param {string} driveId  Shared Drive id (also the root parent for top-level folder)
 * @param {Date} [date]
 * @returns {Promise<string>}  folderId of the month folder
 */
async function ensureMonthFolder(token, driveId, date = new Date()) {
  // Use Asia/Dhaka (UTC+6) so month boundaries match the owner's day.
  const dhaka = new Date(date.getTime() + 6 * 60 * 60 * 1000)
  const year = String(dhaka.getUTCFullYear())
  const monthIdx = dhaka.getUTCMonth()
  const monthLabel = `${String(monthIdx + 1).padStart(2, '0')}-${MONTH_NAMES[monthIdx]}`

  // The Shared Drive id doubles as the parent id for top-level files/folders.
  const rootId = await ensureFolder(token, driveId, ROOT_FOLDER_NAME, driveId)
  const yearId = await ensureFolder(token, driveId, year, rootId)
  const monthId = await ensureFolder(token, driveId, monthLabel, yearId)
  return monthId
}

/**
 * Upload a buffer to the month folder via a multipart Drive upload.
 * @param {object} args
 * @param {Buffer} args.buffer
 * @param {string} args.name        Filename to store in Drive
 * @param {string} args.contentType e.g. 'image/png', 'video/mp4'
 * @param {Date} [args.date]        Date used to pick the month folder
 * @returns {Promise<{ fileId: string, webViewLink: string, folderId: string }>}
 */
export async function uploadToDrive({ buffer, name, contentType, date }) {
  const creds = getCredentials()
  if (!creds) throw new Error('GOOGLE_TTS_CREDENTIALS not set or invalid JSON')
  const driveId = getDriveId()
  if (!driveId) throw new Error('STUDIO_DRIVE_ID not set')

  const token = await getAccessToken(creds)
  const folderId = await ensureMonthFolder(token, driveId, date)

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
    '?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink'

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
 * @param {string} fileId
 * @returns {Promise<boolean>}
 */
export async function verifyDriveFile(fileId) {
  const creds = getCredentials()
  if (!creds || !fileId) return false
  try {
    const token = await getAccessToken(creds)
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`)
    url.searchParams.set('fields', 'id,trashed,size')
    url.searchParams.set('supportsAllDrives', 'true')
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

/**
 * Download a Drive file's bytes (used by the gallery proxy after the Supabase
 * copy is deleted).
 * @param {string} fileId
 * @returns {Promise<{ buffer: Buffer, contentType: string } | null>}
 */
export async function downloadFromDrive(fileId) {
  const creds = getCredentials()
  if (!creds || !fileId) return null
  const token = await getAccessToken(creds)
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`)
  url.searchParams.set('alt', 'media')
  url.searchParams.set('supportsAllDrives', 'true')
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) {
    console.warn('[drive] downloadFromDrive failed:', res.status, await res.text())
    return null
  }
  const contentType = res.headers.get('content-type') || 'application/octet-stream'
  const buffer = Buffer.from(await res.arrayBuffer())
  return { buffer, contentType }
}
