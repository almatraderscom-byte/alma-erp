import { isHeicLike, logTradingUpload } from '@/lib/trading-screenshot-picker'

/** Client-side screenshot compression before upload (webp, max width 1600). HEIC is sent as-is for server sharp. */
export async function optimizeTradingScreenshot(file: File): Promise<File> {
  if (typeof window === 'undefined') return file

  logTradingUpload('optimize:start', {
    name: file.name,
    type: file.type || '(empty)',
    size: file.size,
    heic: isHeicLike(file),
  })

  if (isHeicLike(file)) {
    logTradingUpload('optimize:skip-heic', { size: file.size })
    return file
  }

  const type = (file.type || '').toLowerCase()
  const canDecode = type.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(file.name)
  if (!canDecode) {
    logTradingUpload('optimize:passthrough-unknown-type', { type: file.type })
    return file
  }

  try {
    const bitmap = await createImageBitmap(file)
    const maxWidth = 1600
    const scale = Math.min(1, maxWidth / bitmap.width)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      logTradingUpload('optimize:no-canvas', {})
      return file
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.82))
    bitmap.close()
    if (!blob || blob.size >= file.size) {
      logTradingUpload('optimize:skipped-larger-or-failed-blob', { blobSize: blob?.size, original: file.size })
      return file
    }
    const out = new File(
      [blob],
      `${file.name.replace(/\.[^.]+$/, '') || 'performance-screenshot'}.webp`,
      { type: 'image/webp',
      },
    )
    logTradingUpload('optimize:done', { before: file.size, after: out.size, type: out.type })
    return out
  } catch (e) {
    logTradingUpload('optimize:error', { message: (e as Error).message })
    return file
  }
}
