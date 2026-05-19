import { createHash } from 'crypto'

const MAX_INPUT_BYTES = 12 * 1024 * 1024
const MAX_OUTPUT_BYTES = 3 * 1024 * 1024
const MAX_WIDTH = 1600

export type NormalizedTradingImage = {
  buffer: Buffer
  mimeType: string
  extension: string
  contentHash: string
  originalSize: number
  normalizedSize: number
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export async function normalizeTradingScreenshotUpload(
  file: File,
  safeName: string,
): Promise<NormalizedTradingImage> {
  const originalSize = file.size
  if (originalSize <= 0 || originalSize > MAX_INPUT_BYTES) {
    throw new Error(`Screenshot must be between 1 byte and ${Math.round(MAX_INPUT_BYTES / (1024 * 1024))} MB.`)
  }

  let buffer = Buffer.from(await file.arrayBuffer())
  let mimeType = file.type || 'application/octet-stream'
  let extension = extensionForMime(mimeType, safeName)

  const needsProcessing =
    !['image/jpeg', 'image/png', 'image/webp'].includes(mimeType) ||
    buffer.length > MAX_OUTPUT_BYTES ||
    mimeType === 'image/heic' ||
    mimeType === 'image/heif' ||
    /\.heic$/i.test(safeName)

  if (needsProcessing) {
    try {
      const sharp = (await import('sharp')).default
      const pipeline = sharp(buffer, { failOn: 'none' }).rotate().resize({
        width: MAX_WIDTH,
        height: MAX_WIDTH,
        fit: 'inside',
        withoutEnlargement: true,
      })
      buffer = await pipeline.webp({ quality: 82 }).toBuffer()
      mimeType = 'image/webp'
      extension = '.webp'
    } catch (e) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
        throw new Error('Unsupported image format. Use JPEG, PNG, WebP, or HEIC.')
      }
      if (buffer.length > MAX_OUTPUT_BYTES) {
        throw new Error('Screenshot is too large after upload. Please compress and retry.')
      }
      throw e
    }
  }

  if (buffer.length > MAX_OUTPUT_BYTES) {
    throw new Error('Screenshot is too large. Maximum size is 3 MB.')
  }

  return {
    buffer,
    mimeType,
    extension,
    contentHash: sha256Buffer(buffer),
    originalSize,
    normalizedSize: buffer.length,
  }
}

function extensionForMime(type: string, safeName: string) {
  const fromName = safeName.match(/\.[a-z0-9]{2,6}$/i)?.[0]?.toLowerCase()
  if (fromName) return fromName
  if (type === 'image/png') return '.png'
  if (type === 'image/webp') return '.webp'
  if (type === 'image/jpeg') return '.jpg'
  return '.jpg'
}
