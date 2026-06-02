/** Routes that must never be used as post-login redirect targets (avoids /login loops). */
const AUTH_PATH_PREFIXES = ['/login', '/forgot-password', '/reset-password'] as const

export function isAuthPath(pathname: string): boolean {
  const path = pathname.split('?')[0] || '/'
  return AUTH_PATH_PREFIXES.some(p => path === p || path.startsWith(`${p}/`))
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
