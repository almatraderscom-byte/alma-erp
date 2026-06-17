/** Routes that must never be used as post-login redirect targets (avoids /login loops). */
const AUTH_PATH_PREFIXES = ['/login', '/forgot-password', '/reset-password'] as const

const PUBLIC_APP_PREFIXES = ['/app/download', '/download.html', '/privacy-policy', '/releases'] as const

export function isAuthPath(pathname: string): boolean {
  const path = pathname.split('?')[0] || '/'
  return AUTH_PATH_PREFIXES.some(p => path === p || path.startsWith(`${p}/`))
}

/** Staff APK download — no login required. */
export function isPublicAppPath(pathname: string): boolean {
  const path = pathname.split('?')[0] || '/'
  return PUBLIC_APP_PREFIXES.some(p => path === p || path.startsWith(`${p}/`))
}

/** Dev-only Phase C UI mock — no login, no API (production stays owner-gated). */
function isDevCreativeStudioDemo(pathname: string): boolean {
  return (
    process.env.NODE_ENV !== 'production'
    && (pathname === '/agent/creative-studio-demo'
      || pathname.startsWith('/agent/creative-studio-demo/')
      || pathname === '/agent/creative-studio'
      || pathname.startsWith('/agent/creative-studio/'))
  )
}

export function isPublicPath(pathname: string): boolean {
  if (isDevCreativeStudioDemo(pathname)) return true
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
