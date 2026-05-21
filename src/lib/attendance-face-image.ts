/** Parse and validate face verification images (check-in only). */

import { MAX_FACE_IMAGE_BYTES, MAX_THUMB_DATA_URL_CHARS } from '@/lib/attendance-face-constants'

export { MAX_FACE_IMAGE_BYTES, MAX_THUMB_DATA_URL_CHARS } from '@/lib/attendance-face-constants'

export type ParsedFaceImage = {
  buffer: Buffer
  contentType: string
  sizeBytes: number
}

function parseFaceImageDataUrlRaw(dataUrl: string, maxBytes = MAX_FACE_IMAGE_BYTES): ParsedFaceImage | null {
  const match = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i.exec(dataUrl.trim())
  if (!match) return null
  const contentType = match[1].toLowerCase()
  if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(contentType)) return null
  try {
    const buffer = Buffer.from(match[2], 'base64')
    if (!buffer.length || buffer.length > maxBytes) return null
    return { buffer, contentType: contentType === 'image/jpg' ? 'image/jpeg' : contentType, sizeBytes: buffer.length }
  } catch {
    return null
  }
}

export function parseFaceImageDataUrl(dataUrl: string): ParsedFaceImage | null {
  return parseFaceImageDataUrlRaw(dataUrl, MAX_FACE_IMAGE_BYTES)
}

/** Hard ceiling on a single Sharp decode/resize so a malformed image cannot hang the lambda. */
const SHARP_DECODE_TIMEOUT_MS = 8_000

async function withSharpTimeout<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race<T | 'timeout'>([
      fn(),
      new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), SHARP_DECODE_TIMEOUT_MS)
      }),
    ])
    if (result === 'timeout') {
      // Swallowed at call site; we cannot cancel an in-flight Sharp pipeline, but the
      // promise will resolve later and the result will be discarded.
      // eslint-disable-next-line no-console
      console.warn(`[attendance-face-image] ${label} timed out after ${SHARP_DECODE_TIMEOUT_MS}ms`)
      return null
    }
    return result
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Accept large mobile captures, then compress server-side for storage + Telegram. */
export async function normalizeFaceImageForCheckIn(dataUrl: string): Promise<ParsedFaceImage | null> {
  const loose = parseFaceImageDataUrlRaw(dataUrl, 900_000)
  if (!loose) return null
  if (loose.sizeBytes <= MAX_FACE_IMAGE_BYTES) return loose

  const out = await withSharpTimeout('normalizeFaceImageForCheckIn', async () => {
    const sharp = (await import('sharp')).default
    return sharp(loose.buffer, { failOn: 'none' })
      .rotate()
      .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 58, mozjpeg: true })
      .toBuffer()
  })
  if (!out || !out.length || out.length > MAX_FACE_IMAGE_BYTES) return null
  return { buffer: out, contentType: 'image/jpeg', sizeBytes: out.length }
}

export async function buildFaceThumbDataUrl(buffer: Buffer): Promise<string | null> {
  const out = await withSharpTimeout('buildFaceThumbDataUrl', async () => {
    const sharp = (await import('sharp')).default
    return sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({ width: 160, height: 160, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 44, mozjpeg: true })
      .toBuffer()
  })
  if (!out) return null
  const dataUrl = `data:image/jpeg;base64,${out.toString('base64')}`
  if (dataUrl.length > MAX_THUMB_DATA_URL_CHARS) return null
  return dataUrl
}

export function thumbBufferFromDataUrl(dataUrl: string | null | undefined): Buffer | null {
  if (!dataUrl) return null
  const parsed = parseFaceImageDataUrl(dataUrl)
  return parsed?.buffer ?? null
}
