import { createSignedObjectUrl, ensureBucket, storageConfig } from '@/lib/supabase-storage'

export const PROFILE_IMAGE_MAX_BYTES = 2 * 1024 * 1024
const ALLOWED_INPUT = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])

export function profileImageObjectPath(userId: string) {
  return `profiles/${userId}/avatar.webp`
}

export function profileThumbObjectPath(userId: string) {
  return `profiles/${userId}/thumb.webp`
}

export async function processProfileImageUpload(buffer: Buffer, contentType: string) {
  const sharp = (await import('sharp')).default
  let pipeline = sharp(buffer, { failOn: 'none' }).rotate()
  if (contentType === 'image/heic' || contentType === 'image/heif') {
    pipeline = pipeline.heif()
  }
  const avatar = await pipeline
    .resize(512, 512, { fit: 'cover', position: 'centre' })
    .webp({ quality: 82 })
    .toBuffer()
  const thumb = await sharp(avatar)
    .resize(96, 96, { fit: 'cover', position: 'centre' })
    .webp({ quality: 70 })
    .toBuffer()
  if (avatar.length > PROFILE_IMAGE_MAX_BYTES) {
    throw new Error('Image is too large after optimization. Try a simpler photo.')
  }
  return { avatar, thumb, contentType: 'image/webp' }
}

export async function uploadProfileImages(userId: string, avatar: Buffer, thumb: Buffer) {
  const cfg = storageConfig()
  const avatarPath = profileImageObjectPath(userId)
  const thumbPath = profileThumbObjectPath(userId)
  await uploadStorageObjectUpsert(avatarPath, avatar, 'image/webp')
  await uploadStorageObjectUpsert(thumbPath, thumb, 'image/webp')
  return { bucket: cfg.bucket, avatarPath, thumbPath }
}

export async function deleteProfileImages(userId: string) {
  const cfg = storageConfig()
  for (const objectPath of [profileImageObjectPath(userId), profileThumbObjectPath(userId)]) {
    await fetch(`${cfg.url}/storage/v1/object/${encodeURIComponent(cfg.bucket)}/${objectPath}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${cfg.serviceKey}`,
        apikey: cfg.serviceKey,
      },
    }).catch(() => null)
  }
}

export async function fetchProfileImageBuffer(userId: string, variant: 'avatar' | 'thumb' = 'avatar') {
  const cfg = storageConfig()
  const objectPath = variant === 'thumb' ? profileThumbObjectPath(userId) : profileImageObjectPath(userId)
  const signed = await createSignedObjectUrl(cfg.bucket, objectPath, false)
  const res = await fetch(signed)
  if (!res.ok) return null
  const buf = Buffer.from(await res.arrayBuffer())
  return { buffer: buf, contentType: res.headers.get('content-type') || 'image/webp' }
}

async function uploadStorageObjectUpsert(objectPath: string, body: Buffer, contentType: string) {
  const cfg = await ensureBucket()
  const { url, serviceKey, bucket } = cfg
  const res = await fetch(`${url}/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body,
  })
  if (!res.ok) {
    throw new Error(`Profile upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
}

export function validateProfileImageFile(file: File) {
  const type = (file.type || '').toLowerCase()
  const name = file.name.toLowerCase()
  const okType =
    ALLOWED_INPUT.has(type)
    || name.endsWith('.jpg')
    || name.endsWith('.jpeg')
    || name.endsWith('.png')
    || name.endsWith('.webp')
    || name.endsWith('.heic')
  if (!okType) return { ok: false as const, error: 'Use JPG, PNG, WEBP, or HEIC.' }
  if (file.size <= 0 || file.size > 8 * 1024 * 1024) {
    return { ok: false as const, error: 'Image must be between 1 byte and 8 MB.' }
  }
  return { ok: true as const }
}
