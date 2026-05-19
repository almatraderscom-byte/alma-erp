/** Client helpers for trading screenshot pick / validate / debug (mobile-safe). */

export type ScreenshotPickSource = 'gallery' | 'camera' | 'drop'

export function isMobileTradingDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return /Android|iPhone|iPad|iPod|Mobile|SamsungBrowser/i.test(ua)
}

export function isIosTradingDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/** Gallery picker — never use `capture` (allows Photos / Files). */
export const TRADING_SCREENSHOT_GALLERY_ACCEPT = 'image/*'

/** Camera-only input — `capture` only on explicit “Take photo” tap. */
export const TRADING_SCREENSHOT_CAMERA_ACCEPT = 'image/*'

export function isAcceptedTradingScreenshot(file: File, source: ScreenshotPickSource): boolean {
  const type = (file.type || '').toLowerCase().trim()
  const name = file.name || ''

  if (/^image\/(jpeg|jpg|png|webp|heic|heif|pjpeg)$/i.test(type)) return true
  if (/^image\//i.test(type)) return true
  if (/\.(jpe?g|png|webp|heic|heif)$/i.test(name)) return true

  // iOS Safari / PWA often returns empty type for camera & gallery picks.
  if ((source === 'gallery' || source === 'camera') && !type && file.size > 0) return true

  return false
}

export function isHeicLike(file: File): boolean {
  const type = (file.type || '').toLowerCase()
  return /heic|heif/i.test(type) || /\.heic$/i.test(file.name || '')
}

export function formatUploadUserError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const lower = raw.toLowerCase()

  if (lower.includes('abort') || lower.includes('timed out') || lower.includes('timeout')) {
    return 'Upload timed out — check your connection and tap Retry.'
  }
  if (lower.includes('network') || lower.includes('failed to fetch')) {
    return 'Network error — check mobile data or Wi‑Fi and try again.'
  }
  if (lower.includes('unsupported') || lower.includes('format')) {
    return 'Unsupported file — use a photo (JPEG, PNG, WebP, or HEIC).'
  }
  if (lower.includes('too large') || lower.includes('maximum size')) {
    return 'Image is too large — try a smaller screenshot or crop the photo.'
  }
  if (lower.includes('duplicate') || lower.includes('already uploaded')) {
    return raw.replace(/^(GET|POST) \/api\/\S+ → /, '')
  }
  if (lower.includes('cooldown') || lower.includes('wait before')) {
    return raw.replace(/^(GET|POST) \/api\/\S+ → /, '')
  }
  if (lower.includes('compress') || lower.includes('prepare')) {
    return 'Could not prepare the image — try another photo or format.'
  }

  return raw.replace(/^(GET|POST) \/api\/\S+ → /, '') || 'Upload failed — please try again.'
}

const DEBUG_KEY = 'alma-trading-upload-debug'
const DEBUG_LOG_KEY = 'alma-trading-upload-debug-log'
const MAX_DEBUG_LINES = 40

export function isTradingUploadDebugEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(DEBUG_KEY) === '1'
}

export function logTradingUpload(stage: string, detail?: Record<string, unknown>) {
  const line = {
    ts: new Date().toISOString(),
    stage,
    ...detail,
  }
  if (typeof console !== 'undefined') {
    console.info('[trading-upload]', line)
  }
  if (typeof sessionStorage === 'undefined' || !isTradingUploadDebugEnabled()) return
  try {
    const prev = JSON.parse(sessionStorage.getItem(DEBUG_LOG_KEY) || '[]') as unknown[]
    const next = [...prev, line].slice(-MAX_DEBUG_LINES)
    sessionStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

export function readTradingUploadDebugLog(): Array<Record<string, unknown>> {
  if (typeof sessionStorage === 'undefined') return []
  try {
    return JSON.parse(sessionStorage.getItem(DEBUG_LOG_KEY) || '[]') as Array<Record<string, unknown>>
  } catch {
    return []
  }
}

export function clearTradingUploadDebugLog() {
  sessionStorage?.removeItem(DEBUG_LOG_KEY)
}
