import { buildFaceThumbDataUrl, parseFaceImageDataUrl } from '@/lib/attendance-face-image'
import {
  logAttendancePhotoFileMissing,
  logAttendancePhotoIntegrityFailed,
  logAttendancePhotoUploadFailed,
  logAttendancePhotoUploadStarted,
  logAttendancePhotoUploadSuccess,
} from '@/lib/attendance-photo-log'
import {
  createSignedObjectUrl,
  deleteStorageObject,
  downloadStorageObject,
  storageConfig,
  uploadStorageObject,
  type SupabaseUploadResult,
} from '@/lib/supabase-storage'

/** Encoded in AttendanceSelfieVerification.imageDataUrl for durable storage refs. */
export const ATTENDANCE_STORAGE_REF_PREFIX = 'alma-storage:'

export type PreparedCheckInFaceAssets = {
  thumbDataUrl: string
  storage: SupabaseUploadResult
  contentType: string
  sizeBytes: number
  storageRef: string
}

export function encodeAttendanceStorageRef(storage: SupabaseUploadResult): string {
  return `${ATTENDANCE_STORAGE_REF_PREFIX}${storage.bucket}/${storage.objectPath}`
}

export function parseAttendanceStorageRef(ref: string | null | undefined): SupabaseUploadResult | null {
  if (!ref?.startsWith(ATTENDANCE_STORAGE_REF_PREFIX)) return null
  const rest = ref.slice(ATTENDANCE_STORAGE_REF_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const bucket = rest.slice(0, slash)
  const objectPath = rest.slice(slash + 1)
  if (!bucket || !objectPath) return null
  return { bucket, objectPath }
}

function canonicalFaceObjectPath(
  businessId: string,
  employeeId: string,
  requestId: string,
  attendanceDateYmd: string,
) {
  const safeRequest = requestId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'req'
  return `attendance-faces/${businessId}/${employeeId}/${attendanceDateYmd}/${safeRequest}.jpg`
}

export async function resolveAttendanceImageRefForDisplay(
  imageRef: string | null | undefined,
): Promise<string | null> {
  if (!imageRef) return null
  if (imageRef.startsWith('data:image/')) return imageRef
  const storage = parseAttendanceStorageRef(imageRef)
  if (!storage) return null
  try {
    return await createSignedObjectUrl(storage.bucket, storage.objectPath, false, 3600)
  } catch {
    logAttendancePhotoFileMissing({
      bucket: storage.bucket,
      storagePath: storage.objectPath,
      message: 'signed_url_failed',
    })
    return null
  }
}

export async function verifyAttendanceStorageObject(storage: SupabaseUploadResult): Promise<boolean> {
  try {
    const buf = await downloadStorageObject(storage.bucket, storage.objectPath)
    return Boolean(buf?.length && buf.length > 512)
  } catch {
    return false
  }
}

const UPLOAD_TIMEOUT_MS = 22_000

async function uploadWithTimeout(
  objectPath: string,
  buffer: Buffer,
  contentType: string,
): Promise<SupabaseUploadResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)
  try {
    const blob = new Blob([Uint8Array.from(buffer)], { type: contentType })
    return await uploadStorageObject(objectPath, blob, contentType)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Upload + verify face photo BEFORE attendance DB commit.
 * Returns failure if thumb or durable storage cannot be prepared.
 */
export async function prepareCheckInFaceAssets(input: {
  businessId: string
  employeeId: string
  userId: string
  requestId: string
  attendanceDateYmd: string
  buffer: Buffer
  contentType: string
  sizeBytes: number
}): Promise<
  | { ok: true; assets: PreparedCheckInFaceAssets }
  | { ok: false; code: string; message: string }
> {
  const logBase = {
    requestId: input.requestId,
    businessId: input.businessId,
    employeeId: input.employeeId,
    userId: input.userId,
  }
  const started = Date.now()

  const thumbDataUrl = await buildFaceThumbDataUrl(input.buffer)
  if (!thumbDataUrl) {
    logAttendancePhotoIntegrityFailed({
      ...logBase,
      reason: 'thumb_build_failed',
      latencyMs: Date.now() - started,
    })
    return {
      ok: false,
      code: 'face_thumb_failed',
      message: 'Could not prepare verification thumbnail. Retake the photo in good light.',
    }
  }

  const objectPath = canonicalFaceObjectPath(
    input.businessId,
    input.employeeId,
    input.requestId,
    input.attendanceDateYmd,
  )

  logAttendancePhotoUploadStarted({ ...logBase, storagePath: objectPath, sizeBytes: input.sizeBytes })

  let storage: SupabaseUploadResult | null = null
  let lastError = 'upload_failed'
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      storage = await uploadWithTimeout(objectPath, input.buffer, input.contentType)
      const exists = await verifyAttendanceStorageObject(storage)
      if (exists) break
      lastError = 'file_missing_after_upload'
      logAttendancePhotoFileMissing({
        ...logBase,
        bucket: storage.bucket,
        storagePath: storage.objectPath,
        reason: 'verify_empty',
      })
      storage = null
    } catch (e) {
      lastError = (e as Error).message || 'upload_exception'
      logAttendancePhotoUploadFailed({
        ...logBase,
        storagePath: objectPath,
        message: lastError,
        reason: attempt === 1 ? 'retry' : 'exhausted',
      })
      storage = null
    }
  }

  if (!storage) {
    return {
      ok: false,
      code: 'face_upload_failed',
      message:
        'Verification photo could not be saved. Check connection and retry — attendance was not recorded.',
    }
  }

  logAttendancePhotoUploadSuccess({
    ...logBase,
    bucket: storage.bucket,
    storagePath: storage.objectPath,
    latencyMs: Date.now() - started,
  })

  return {
    ok: true,
    assets: {
      thumbDataUrl,
      storage,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      storageRef: encodeAttendanceStorageRef(storage),
    },
  }
}

/**
 * Upload + verify a verification selfie BEFORE writing the DB row.
 * Never stores a raw base64 data URL — always requires Supabase persistence.
 */
export async function prepareVerificationSelfieAssets(input: {
  businessId: string
  employeeId: string
  userId: string
  attendanceRecordId: string
  attendanceDateYmd: string
  imageDataUrl: string
  requestId: string
}): Promise<
  | { ok: true; storageRef: string; contentType: string; sizeBytes: number }
  | { ok: false; code: string; message: string }
> {
  const logBase = {
    requestId: input.requestId,
    businessId: input.businessId,
    employeeId: input.employeeId,
    userId: input.userId,
    attendanceRecordId: input.attendanceRecordId,
  }

  const parsed = parseFaceImageDataUrl(input.imageDataUrl)
  if (!parsed) {
    logAttendancePhotoIntegrityFailed({ ...logBase, reason: 'invalid_data_url' })
    return { ok: false, code: 'invalid_image', message: 'Invalid selfie image format. Retake and try again.' }
  }

  const safeId = input.attendanceRecordId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'rec'
  const objectPath = `attendance-selfies/${input.businessId}/${input.employeeId}/${input.attendanceDateYmd}/${safeId}.jpg`

  logAttendancePhotoUploadStarted({
    ...logBase,
    storagePath: objectPath,
    sizeBytes: parsed.sizeBytes,
  })

  const started = Date.now()
  let storage: SupabaseUploadResult | null = null
  let lastError = 'upload_failed'
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      storage = await uploadWithTimeout(objectPath, parsed.buffer, parsed.contentType)
      const exists = await verifyAttendanceStorageObject(storage)
      if (exists) break
      lastError = 'file_missing_after_upload'
      logAttendancePhotoFileMissing({ ...logBase, bucket: storage.bucket, storagePath: storage.objectPath, reason: 'verify_empty' })
      storage = null
    } catch (e) {
      lastError = (e as Error).message || 'upload_exception'
      logAttendancePhotoUploadFailed({ ...logBase, storagePath: objectPath, message: lastError, reason: attempt === 1 ? 'retry' : 'exhausted' })
      storage = null
    }
  }

  if (!storage) {
    return {
      ok: false,
      code: 'selfie_upload_failed',
      message: 'Verification photo could not be saved. Check your connection and retry.',
    }
  }

  logAttendancePhotoUploadSuccess({
    ...logBase,
    bucket: storage.bucket,
    storagePath: storage.objectPath,
    latencyMs: Date.now() - started,
  })

  return {
    ok: true,
    storageRef: encodeAttendanceStorageRef(storage),
    contentType: parsed.contentType,
    sizeBytes: parsed.sizeBytes,
  }
}

export async function rollbackCheckInFaceUpload(storage: SupabaseUploadResult | null | undefined) {
  if (!storage?.objectPath) return
  try {
    await deleteStorageObject(storage.bucket, storage.objectPath)
  } catch {
    // best-effort cleanup
  }
}

export async function loadAttendanceFacePhotoBuffer(meta: {
  facePhotoBucket?: string
  facePhotoPath?: string
  attendanceRecordId?: string
}): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (meta.facePhotoBucket && meta.facePhotoPath) {
    try {
      const buffer = await downloadStorageObject(meta.facePhotoBucket, meta.facePhotoPath)
      if (buffer.length > 0) return { buffer, contentType: 'image/jpeg' }
    } catch {
      logAttendancePhotoFileMissing({
        bucket: meta.facePhotoBucket,
        storagePath: meta.facePhotoPath,
        attendanceRecordId: meta.attendanceRecordId,
      })
    }
  }

  if (!meta.attendanceRecordId) return null
  const { prisma } = await import('@/lib/prisma')
  const selfie = await prisma.attendanceSelfieVerification.findFirst({
    where: { attendanceRecordId: meta.attendanceRecordId },
    orderBy: { capturedAt: 'desc' },
    select: { imageDataUrl: true, contentType: true },
  })
  const storage = parseAttendanceStorageRef(selfie?.imageDataUrl)
  if (!storage) {
    // Backward-compat: older verification selfie rows stored raw base64 instead of
    // an alma-storage: ref. Parse and return the buffer so Telegram delivery can still
    // attach the photo.
    if (selfie?.imageDataUrl?.startsWith('data:image/')) {
      const parsed = parseFaceImageDataUrl(selfie.imageDataUrl)
      if (parsed) return { buffer: parsed.buffer, contentType: parsed.contentType }
    }
    return null
  }
  try {
    const buffer = await downloadStorageObject(storage.bucket, storage.objectPath)
    if (buffer.length > 0) {
      return { buffer, contentType: selfie?.contentType || 'image/jpeg' }
    }
  } catch {
    logAttendancePhotoFileMissing({
      attendanceRecordId: meta.attendanceRecordId,
      storagePath: storage.objectPath,
      bucket: storage.bucket,
    })
  }
  return null
}

/** When storage is not configured (dev), allow inline thumb-only commit with explicit flag. */
export function attendancePhotoStorageReady(): boolean {
  try {
    return storageConfig().url.length > 0
  } catch {
    return false
  }
}
