const COOLDOWN_MS = 45_000
const FINGERPRINT_PREFIX = 'alma-trading-upload-fp:'

export async function fingerprintFile(file: File): Promise<string> {
  const slice = file.size > 96_000 ? file.slice(0, 96_000) : file
  const buf = await slice.arrayBuffer()
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hash = await crypto.subtle.digest('SHA-256', buf)
    const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
    return `${file.size}:${hex.slice(0, 32)}`
  }
  return `${file.size}:${file.name}:${file.lastModified}`
}

export function readUploadCooldown(accountId: string): number {
  if (typeof sessionStorage === 'undefined') return 0
  const raw = sessionStorage.getItem(`${FINGERPRINT_PREFIX}cooldown:${accountId}`)
  return raw ? Number(raw) || 0 : 0
}

export function markUploadCooldown(accountId: string) {
  if (typeof sessionStorage === 'undefined') return
  sessionStorage.setItem(`${FINGERPRINT_PREFIX}cooldown:${accountId}`, String(Date.now()))
}

export function uploadCooldownRemainingMs(accountId: string): number {
  const last = readUploadCooldown(accountId)
  if (!last) return 0
  return Math.max(0, COOLDOWN_MS - (Date.now() - last))
}

export function readRecentFingerprint(accountId: string, shotDate: string): string | null {
  if (typeof sessionStorage === 'undefined') return null
  return sessionStorage.getItem(`${FINGERPRINT_PREFIX}${accountId}:${shotDate}`)
}

export function rememberFingerprint(accountId: string, shotDate: string, fingerprint: string) {
  if (typeof sessionStorage === 'undefined') return
  sessionStorage.setItem(`${FINGERPRINT_PREFIX}${accountId}:${shotDate}`, fingerprint)
}

export function isDuplicateClientUpload(accountId: string, shotDate: string, fingerprint: string): boolean {
  return readRecentFingerprint(accountId, shotDate) === fingerprint
}

export const TRADING_UPLOAD_COOLDOWN_MS = COOLDOWN_MS
