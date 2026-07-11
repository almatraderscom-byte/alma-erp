/**
 * Creative Studio → Google Drive auto-archive + Supabase cleanup.
 *
 * The gallery accumulates full-resolution images/videos in Supabase Storage,
 * which is finite and costs money. This job runs the owner's "set & forget"
 * archive policy with ZERO manual work:
 *
 *   1. ARCHIVE pass — every executed Creative Studio item whose full-res files
 *      are not yet on Drive gets uploaded into a month-organized folder in the
 *      OWNER's own Google Drive (Creative Studio/YYYY/MM-Month/). The Drive file
 *      ids are recorded back into the item's result JSON (no DB migration).
 *
 *   2. CLEANUP pass — once a file is safely on Drive AND the item is older than
 *      the retention window (default 30 days, tunable via the kv setting
 *      `studio_archive_retention_days`), the big Supabase copy is deleted to
 *      reclaim space. Small thumbnails are KEPT so the gallery grid stays fast.
 *
 * Safety: a Supabase object is NEVER deleted unless its Drive copy is verified
 * to exist and be non-trashed at delete time. Drive is the only-copy guardian.
 */

import { getDriveConnection, getDriveAccessToken, uploadToDrive, verifyDriveFile } from '../drive.mjs'

const BUCKET = 'agent-files'
const ENABLED_KEY = 'studio_archive_enabled'
const RETENTION_KEY = 'studio_archive_retention_days'
const DEFAULT_RETENTION_DAYS = 30

// Bound work per run so a backlog never blocks the worker or hits Drive limits.
const ARCHIVE_BATCH = 20
const CLEANUP_BATCH = 20
const SCAN_LIMIT = 400

// Thumbnail paths are tiny and power the gallery grid — keep them in Supabase.
const THUMBNAIL_KEYS = ['thumbPath', 'brandedThumbPath']

async function readSetting(supabase, key) {
  const { data } = await supabase
    .from('agent_kv_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle()
  return data?.value
}

async function isEnabled(supabase) {
  const v = await readSetting(supabase, ENABLED_KEY)
  // Default ON when Drive is configured; owner can flip the kv key to disable.
  if (v === undefined || v === null) return true
  return v === true || v === 'true' || v === 1 || v === '1'
}

async function getRetentionDays(supabase) {
  const v = await readSetting(supabase, RETENTION_KEY)
  const n = Number(typeof v === 'object' && v !== null ? v.days ?? v.value : v)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS
}

/** Collect the full-res (non-thumbnail) Supabase paths worth archiving. */
function collectBigPaths(result) {
  const paths = new Set()
  const add = (p) => { if (typeof p === 'string' && p.trim()) paths.add(p.trim()) }
  add(result.storagePath)
  add(result.videoPath)
  add(result.brandedPath)
  if (Array.isArray(result.allPaths)) result.allPaths.forEach(add)
  return [...paths]
}

function basename(path) {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}

function guessContentType(path) {
  const ext = path.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'mp4': return 'video/mp4'
    case 'mp3': return 'audio/mpeg'
    case 'm4a': return 'audio/mp4'
    case 'png': return 'image/png'
    case 'webp': return 'image/webp'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    default: return 'application/octet-stream'
  }
}

async function patchResult(supabase, id, result) {
  const { error } = await supabase
    .from('agent_pending_actions')
    .update({ result })
    .eq('id', id)
  if (error) throw new Error(`result patch failed: ${error.message}`)
}

/**
 * @param {{ supabase: import('@supabase/supabase-js').SupabaseClient }} context
 */
export async function runStudioArchive(context) {
  const { supabase } = context

  if (!(await isEnabled(supabase))) {
    console.log('[studio-archive] skipped — disabled by owner')
    return { dutyStatus: 'skipped', dutyDetail: 'disabled by owner' }
  }

  // Drive uses the owner's own account via OAuth (see worker/src/drive.mjs).
  // Needs client creds (env) + a stored refresh token (owner connected once).
  const conn = await getDriveConnection(supabase)
  if (!conn) {
    console.log('[studio-archive] skipped — Drive not connected (owner must Connect Google Drive once)')
    return { dutyStatus: 'skipped', dutyDetail: 'Drive not connected' }
  }
  let accessToken
  try {
    accessToken = await getDriveAccessToken(conn.refreshToken)
  } catch (err) {
    console.error('[studio-archive] token refresh failed:', err.message)
    return { dutyStatus: 'error', dutyDetail: `Drive token ব্যর্থ: ${err.message.slice(0, 40)}` }
  }

  const retentionDays = await getRetentionDays(supabase)
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000

  const { data: rows, error } = await supabase
    .from('agent_pending_actions')
    .select('id, type, status, result, payload, "createdAt"')
    .in('type', ['image_gen', 'video_gen', 'video_edit', 'audio_gen'])
    .eq('status', 'executed')
    .order('createdAt', { ascending: false })
    .limit(SCAN_LIMIT)
  if (error) {
    console.error('[studio-archive] scan failed:', error.message)
    return { dutyStatus: 'error', dutyDetail: `scan ব্যর্থ: ${error.message.slice(0, 40)}` }
  }

  const items = (rows ?? []).filter((r) => {
    const p = r.payload ?? {}
    return p.creativeStudio === true && r.result && typeof r.result === 'object'
  })

  let archived = 0
  let archiveFailed = 0
  let cleaned = 0
  let cleanFailed = 0
  let bytesFreed = 0

  // ── ARCHIVE pass (newest first) ──────────────────────────────────────────
  for (const item of items) {
    if (archived >= ARCHIVE_BATCH) break
    const result = { ...item.result }
    const driveFiles = (result.driveFiles && typeof result.driveFiles === 'object') ? { ...result.driveFiles } : {}
    const bigPaths = collectBigPaths(result)
    const pending = bigPaths.filter((p) => !driveFiles[p]?.fileId)
    if (pending.length === 0) continue

    const createdAt = item.createdAt ? new Date(item.createdAt) : new Date()
    let changed = false
    try {
      for (const path of pending) {
        const { data: file, error: dlErr } = await supabase.storage.from(BUCKET).download(path)
        if (dlErr || !file) {
          // The Supabase object is already gone — record so we don't retry forever.
          console.warn(`[studio-archive] download miss ${path}: ${dlErr?.message ?? 'no data'}`)
          driveFiles[path] = { missing: true }
          changed = true
          continue
        }
        const buffer = Buffer.from(await file.arrayBuffer())
        const up = await uploadToDrive({
          token: accessToken,
          buffer,
          name: basename(path),
          contentType: file.type || guessContentType(path),
          date: createdAt,
        })
        driveFiles[path] = { fileId: up.fileId, webViewLink: up.webViewLink, bytes: buffer.length }
        changed = true
      }
      if (changed) {
        result.driveFiles = driveFiles
        result.driveArchivedAt = new Date().toISOString()
        await patchResult(supabase, item.id, result)
        // Mutate in place so the cleanup pass below sees the fresh archive state.
        item.result = result
        archived += 1
      }
    } catch (err) {
      archiveFailed += 1
      console.error(`[studio-archive] archive failed for ${item.id}:`, err.message)
    }
  }

  // ── CLEANUP pass (oldest first) ──────────────────────────────────────────
  const oldestFirst = [...items].reverse()
  for (const item of oldestFirst) {
    if (cleaned >= CLEANUP_BATCH) break
    const result = { ...item.result }
    if (result.supabaseDeletedAt) continue
    const driveFiles = result.driveFiles
    if (!driveFiles || typeof driveFiles !== 'object') continue
    const createdMs = item.createdAt ? new Date(item.createdAt).getTime() : Date.now()
    if (createdMs > cutoff) continue // still within retention window

    // Only the paths that have a real, verified Drive copy may be deleted.
    const deletable = []
    for (const [path, info] of Object.entries(driveFiles)) {
      if (info?.missing) continue
      if (!info?.fileId) continue
      deletable.push({ path, info })
    }
    if (deletable.length === 0) continue

    try {
      let deletedAny = false
      for (const { path, info } of deletable) {
        const ok = await verifyDriveFile(accessToken, info.fileId)
        if (!ok) {
          console.warn(`[studio-archive] skip delete ${path} — Drive copy unverified`)
          continue
        }
        const { error: rmErr } = await supabase.storage.from(BUCKET).remove([path])
        if (rmErr) {
          console.warn(`[studio-archive] remove failed ${path}: ${rmErr.message}`)
          continue
        }
        bytesFreed += Number(info.bytes ?? 0)
        deletedAny = true
      }
      if (deletedAny) {
        result.supabaseDeletedAt = new Date().toISOString()
        await patchResult(supabase, item.id, result)
        cleaned += 1
      }
    } catch (err) {
      cleanFailed += 1
      console.error(`[studio-archive] cleanup failed for ${item.id}:`, err.message)
    }
  }

  const mbFreed = (bytesFreed / (1024 * 1024)).toFixed(1)
  const detail =
    `${archived} archived` +
    (archiveFailed ? ` (${archiveFailed} fail)` : '') +
    `, ${cleaned} cleaned` +
    (cleanFailed ? ` (${cleanFailed} fail)` : '') +
    `, ${mbFreed}MB freed (retention ${retentionDays}d)`
  console.log('[studio-archive] done —', detail)
  return {
    dutyStatus: archiveFailed || cleanFailed ? 'error' : 'done',
    dutyDetail: detail,
  }
}
