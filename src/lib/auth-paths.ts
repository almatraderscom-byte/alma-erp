/** Routes that must never be used as post-login redirect targets (avoids /login loops). */
const AUTH_PATH_PREFIXES = ['/login', '/forgot-password', '/reset-password'] as const

const PUBLIC_APP_PREFIXES = ['/app/download'] as const

export function isAuthPath(pathname: string): boolean {
  const path = pathname.split('?')[0] || '/'
  return AUTH_PATH_PREFIXES.some(p => path === p || path.startsWith(`${p}/`))
}

/** Staff APK download — no login required. */
export function isPublicAppPath(pathname: string): boolean {
  const path = pathname.split('?')[0] || '/'
  return PUBLIC_APP_PREFIXES.some(p => path === p || path.startsWith(`${p}/`))
}

export function isPublicPath(pathname: string): boolean {
  return isAuthPath(pathname) || isPublicAppPath(pathname)
}

/** Normalize callbackUrl from query string — never return an auth page. */
export function safeAuthCallbackUrl(raw: string | null | undefined): string {
  if (!raw) return '/'
  const trimmed = raw.trim()
  if (!trimmed.startsWith('/')) return '/'
  const pathname = trimmed.split('?')[0] || '/'
  if (isAuthPath(pathname)) return '/'
  return trimmed
}
