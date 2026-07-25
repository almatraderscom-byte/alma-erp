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
const DEFAULT_VERIFICATION_GRACE_HOURS = 24

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

async function getRetentionPolicy(supabase) {
  const { data: stored, error } = await supabase
    .from('creative_retention_policies')
    .select('archive_enabled, delete_originals_enabled, retention_days, verification_grace_hours')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`retention policy read failed: ${error.message}`)
  if (stored) {
    return {
      archiveEnabled: stored.archive_enabled !== false,
      deleteOriginalsEnabled: stored.delete_originals_enabled !== false,
      retentionDays: Number(stored.retention_days) || DEFAULT_RETENTION_DAYS,
      verificationGraceHours:
        Number(stored.verification_grace_hours) || DEFAULT_VERIFICATION_GRACE_HOURS,
    }
  }
  // Backward-compatible fallbacks keep the existing owner KV controls working
  // until the new owner policy is saved once.
  const [enabled, retention] = await Promise.all([
    readSetting(supabase, ENABLED_KEY),
    readSetting(supabase, RETENTION_KEY),
  ])
  const retentionDays = Number(
    typeof retention === 'object' && retention !== null
      ? retention.days ?? retention.value
      : retention,
  )
  return {
    archiveEnabled:
      enabled === undefined || enabled === null
        ? true
        : enabled === true || enabled === 'true' || enabled === 1 || enabled === '1',
    deleteOriginalsEnabled: true,
    retentionDays:
      Number.isFinite(retentionDays) && retentionDays > 0
        ? retentionDays
        : DEFAULT_RETENTION_DAYS,
    verificationGraceHours: DEFAULT_VERIFICATION_GRACE_HOURS,
  }
}

/** Collect the full-res (non-thumbnail) Supabase paths worth archiving. */
export function collectBigPaths(result) {
  const paths = new Set()
  const add = (p) => { if (typeof p === 'string' && p.trim()) paths.add(p.trim()) }
  add(result.storagePath)
  add(result.videoPath)
  add(result.brandedPath)
  if (Array.isArray(result.allPaths)) result.allPaths.forEach(add)
  return [...paths]
}

export function archiveReceiptDeletionEligibility({
  createdAt,
  verifiedAt,
  originalDeletedAt = null,
  now,
  retentionDays,
  verificationGraceHours,
  deleteOriginalsEnabled = true,
}) {
  if (!deleteOriginalsEnabled) return { eligible: false, reason: 'deletion_disabled' }
  if (originalDeletedAt) return { eligible: false, reason: 'already_deleted' }
  if (!verifiedAt) return { eligible: false, reason: 'durable_verification_required' }
  const createdMs = new Date(createdAt).getTime()
  const verifiedMs = new Date(verifiedAt).getTime()
  const nowMs = new Date(now).getTime()
  if (!Number.isFinite(createdMs) || !Number.isFinite(verifiedMs) || !Number.isFinite(nowMs)) {
    return { eligible: false, reason: 'invalid_receipt_time' }
  }
  if (nowMs < createdMs + retentionDays * 24 * 60 * 60 * 1000) {
    return { eligible: false, reason: 'retention_window_active' }
  }
  if (nowMs < verifiedMs + verificationGraceHours * 60 * 60 * 1000) {
    return { eligible: false, reason: 'verification_grace_active' }
  }
  return { eligible: true, reason: 'verified_archive_retention_elapsed' }
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

async function assetVersionMap(supabase, pendingActionIds) {
  if (pendingActionIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from('creative_asset_versions')
    .select('id, job_id')
    .in('job_id', pendingActionIds)
  if (error) throw new Error(`asset version lookup failed: ${error.message}`)
  return new Map((data ?? []).map((row) => [row.job_id, row.id]))
}

async function getArchiveReceipt(supabase, pendingActionId, storagePath) {
  const { data, error } = await supabase
    .from('creative_archive_receipts')
    .select('*')
    .eq('pending_action_id', pendingActionId)
    .eq('storage_path', storagePath)
    .maybeSingle()
  if (error) throw new Error(`archive receipt read failed: ${error.message}`)
  return data
}

async function upsertArchiveReceipt(supabase, input) {
  const now = new Date().toISOString()
  const previous = await getArchiveReceipt(
    supabase,
    input.pendingActionId,
    input.storagePath,
  )
  const { data, error } = await supabase
    .from('creative_archive_receipts')
    .upsert({
      pending_action_id: input.pendingActionId,
      asset_version_id: input.assetVersionId ?? previous?.asset_version_id ?? null,
      storage_path: input.storagePath,
      drive_file_id: input.driveFileId,
      drive_web_view_url: input.driveWebViewUrl ?? previous?.drive_web_view_url ?? null,
      size_bytes: input.sizeBytes ?? previous?.size_bytes ?? null,
      archived_at: previous?.archived_at ?? input.archivedAt ?? now,
      verified_at: input.verifiedAt ?? previous?.verified_at ?? null,
      last_verified_at: input.lastVerifiedAt ?? previous?.last_verified_at ?? null,
      original_deleted_at: input.originalDeletedAt ?? previous?.original_deleted_at ?? null,
      attempts: Number(previous?.attempts ?? 0) + 1,
      last_error_code: input.lastErrorCode ?? null,
      last_attempt_at: now,
      updated_at: now,
    }, { onConflict: 'pending_action_id,storage_path' })
    .select('*')
    .single()
  if (error) throw new Error(`archive receipt write failed: ${error.message}`)
  return data
}

async function writeArchiveObservability(supabase, detail) {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('agent_kv_settings')
    .upsert({
      key: 'studio_archive_last_run',
      value: JSON.stringify(detail),
      updated_at: now,
    }, { onConflict: 'key' })
  if (error) console.warn('[studio-archive] observability write failed:', error.message)
}

/**
 * @param {{ supabase: import('@supabase/supabase-js').SupabaseClient }} context
 */
export async function runStudioArchive(context) {
  const { supabase } = context

  const policy = await getRetentionPolicy(supabase)
  if (!policy.archiveEnabled) {
    console.log('[studio-archive] skipped — disabled by owner')
    await writeArchiveObservability(supabase, {
      status: 'skipped',
      reason: 'disabled_by_owner',
      at: new Date().toISOString(),
    })
    return { dutyStatus: 'skipped', dutyDetail: 'disabled by owner' }
  }

  // Drive uses the owner's own account via OAuth (see worker/src/drive.mjs).
  // Needs client creds (env) + a stored refresh token (owner connected once).
  const conn = await getDriveConnection(supabase)
  if (!conn) {
    console.log('[studio-archive] skipped — Drive not connected (owner must Connect Google Drive once)')
    await writeArchiveObservability(supabase, {
      status: 'skipped',
      reason: 'drive_not_connected',
      at: new Date().toISOString(),
    })
    return { dutyStatus: 'skipped', dutyDetail: 'Drive not connected' }
  }
  let accessToken
  try {
    accessToken = await getDriveAccessToken(conn.refreshToken)
  } catch (err) {
    console.error('[studio-archive] token refresh failed:', err.message)
    await writeArchiveObservability(supabase, {
      status: 'error',
      reason: 'drive_token_refresh_failed',
      at: new Date().toISOString(),
    })
    return { dutyStatus: 'error', dutyDetail: `Drive token ব্যর্থ: ${err.message.slice(0, 40)}` }
  }

  const retentionDays = policy.retentionDays
  const verificationGraceHours = policy.verificationGraceHours

  const { data: rows, error } = await supabase
    .from('agent_pending_actions')
    .select('id, type, status, result, payload, "createdAt"')
    .in('type', ['image_gen', 'video_gen', 'video_edit', 'audio_gen'])
    .eq('status', 'executed')
    .order('createdAt', { ascending: false })
    .limit(SCAN_LIMIT)
  if (error) {
    console.error('[studio-archive] scan failed:', error.message)
    await writeArchiveObservability(supabase, {
      status: 'error',
      reason: 'scan_failed',
      at: new Date().toISOString(),
    })
    return { dutyStatus: 'error', dutyDetail: `scan ব্যর্থ: ${error.message.slice(0, 40)}` }
  }

  const items = (rows ?? []).filter((r) => {
    const p = r.payload ?? {}
    return p.creativeStudio === true && r.result && typeof r.result === 'object'
  })
  const versionsByAction = await assetVersionMap(
    supabase,
    items.map((item) => item.id),
  )

  let archived = 0
  let archiveFailed = 0
  let cleaned = 0
  let cleanFailed = 0
  let bytesFreed = 0
  let durableVerified = 0

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
        const verified = await verifyDriveFile(accessToken, up.fileId)
        const verifiedAt = verified ? new Date().toISOString() : null
        await upsertArchiveReceipt(supabase, {
          pendingActionId: item.id,
          assetVersionId: versionsByAction.get(item.id) ?? null,
          storagePath: path,
          driveFileId: up.fileId,
          driveWebViewUrl: up.webViewLink,
          sizeBytes: buffer.length,
          archivedAt: new Date().toISOString(),
          verifiedAt,
          lastVerifiedAt: verifiedAt,
          lastErrorCode: verified ? null : 'drive_fetch_back_unverified',
        })
        if (verified) durableVerified += 1
        driveFiles[path] = {
          fileId: up.fileId,
          webViewLink: up.webViewLink,
          bytes: buffer.length,
          verifiedAt,
        }
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
  // A receipt must already be durable for the configured grace period. A
  // legacy JSON-only Drive entry is converted into a receipt on this run and
  // deliberately cannot be deleted until a later run.
  if (policy.deleteOriginalsEnabled) {
    const oldestFirst = [...items].reverse()
    for (const item of oldestFirst) {
      if (cleaned >= CLEANUP_BATCH) break
      const result = { ...item.result }
      if (result.supabaseDeletedAt) continue
      const driveFiles = result.driveFiles
      if (!driveFiles || typeof driveFiles !== 'object') continue
      const bigPaths = collectBigPaths(result)
      if (bigPaths.length === 0) continue

      try {
        let deletedAny = false
        for (const path of bigPaths) {
          const info = driveFiles[path]
          if (info?.missing || !info?.fileId) continue
          let receipt = await getArchiveReceipt(supabase, item.id, path)
          if (!receipt) {
            const verified = await verifyDriveFile(accessToken, info.fileId)
            receipt = await upsertArchiveReceipt(supabase, {
              pendingActionId: item.id,
              assetVersionId: versionsByAction.get(item.id) ?? null,
              storagePath: path,
              driveFileId: info.fileId,
              driveWebViewUrl: info.webViewLink,
              sizeBytes: Number(info.bytes ?? 0) || null,
              archivedAt: result.driveArchivedAt ?? new Date().toISOString(),
              verifiedAt: verified ? new Date().toISOString() : null,
              lastVerifiedAt: verified ? new Date().toISOString() : null,
              lastErrorCode: verified ? null : 'drive_fetch_back_unverified',
            })
            // Durable grace starts now; never delete on the receipt-creation run.
            if (verified) durableVerified += 1
            continue
          }
          const eligibility = archiveReceiptDeletionEligibility({
            createdAt: item.createdAt ?? new Date(),
            verifiedAt: receipt.verified_at,
            originalDeletedAt: receipt.original_deleted_at,
            now: new Date(),
            retentionDays,
            verificationGraceHours,
            deleteOriginalsEnabled: policy.deleteOriginalsEnabled,
          })
          if (!eligibility.eligible) continue

          const verifiedAgain = await verifyDriveFile(accessToken, receipt.drive_file_id)
          const lastVerifiedAt = new Date().toISOString()
          receipt = await upsertArchiveReceipt(supabase, {
            pendingActionId: item.id,
            assetVersionId: versionsByAction.get(item.id) ?? null,
            storagePath: path,
            driveFileId: receipt.drive_file_id,
            driveWebViewUrl: receipt.drive_web_view_url,
            sizeBytes: receipt.size_bytes,
            archivedAt: receipt.archived_at,
            verifiedAt: receipt.verified_at,
            lastVerifiedAt,
            lastErrorCode: verifiedAgain ? null : 'drive_reverification_failed',
          })
          if (!verifiedAgain) {
            console.warn(`[studio-archive] skip delete ${path} — Drive copy re-verification failed`)
            continue
          }
          const { error: rmErr } = await supabase.storage.from(BUCKET).remove([path])
          if (rmErr) {
            await upsertArchiveReceipt(supabase, {
              pendingActionId: item.id,
              assetVersionId: versionsByAction.get(item.id) ?? null,
              storagePath: path,
              driveFileId: receipt.drive_file_id,
              archivedAt: receipt.archived_at,
              verifiedAt: receipt.verified_at,
              lastVerifiedAt,
              lastErrorCode: 'supabase_remove_failed',
            })
            console.warn(`[studio-archive] remove failed ${path}: ${rmErr.message}`)
            continue
          }
          await upsertArchiveReceipt(supabase, {
            pendingActionId: item.id,
            assetVersionId: versionsByAction.get(item.id) ?? null,
            storagePath: path,
            driveFileId: receipt.drive_file_id,
            driveWebViewUrl: receipt.drive_web_view_url,
            sizeBytes: receipt.size_bytes,
            archivedAt: receipt.archived_at,
            verifiedAt: receipt.verified_at,
            lastVerifiedAt,
            originalDeletedAt: new Date().toISOString(),
            lastErrorCode: null,
          })
          bytesFreed += Number(receipt.size_bytes ?? info.bytes ?? 0)
          deletedAny = true
        }

        if (deletedAny) {
          const finalReceipts = await Promise.all(
            bigPaths.map((path) => getArchiveReceipt(supabase, item.id, path)),
          )
          const fullyDeleted = bigPaths.every((path, index) => (
            driveFiles[path]?.missing || Boolean(finalReceipts[index]?.original_deleted_at)
          ))
          if (fullyDeleted) {
            result.supabaseDeletedAt = new Date().toISOString()
            await patchResult(supabase, item.id, result)
          }
          cleaned += 1
        }
      } catch (err) {
        cleanFailed += 1
        console.error(`[studio-archive] cleanup failed for ${item.id}:`, err.message)
      }
    }
  }

  const mbFreed = (bytesFreed / (1024 * 1024)).toFixed(1)
  const detail =
    `${archived} archived` +
    (archiveFailed ? ` (${archiveFailed} fail)` : '') +
    `, ${cleaned} cleaned` +
    (cleanFailed ? ` (${cleanFailed} fail)` : '') +
    `, ${durableVerified} verified` +
    `, ${mbFreed}MB freed (retention ${retentionDays}d, grace ${verificationGraceHours}h)`
  console.log('[studio-archive] done —', detail)
  await writeArchiveObservability(supabase, {
    status: archiveFailed || cleanFailed ? 'error' : 'done',
    archived,
    archiveFailed,
    durableVerified,
    cleaned,
    cleanFailed,
    bytesFreed,
    retentionDays,
    verificationGraceHours,
    at: new Date().toISOString(),
  })
  return {
    dutyStatus: archiveFailed || cleanFailed ? 'error' : 'done',
    dutyDetail: detail,
  }
}
