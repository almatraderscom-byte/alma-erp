'use client'

import { usePathname, useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'

/**
 * Native-app back affordance. Mounted once inside PageHeader (and reused by the
 * full-screen flows that don't use PageHeader) so every screen gets a consistent
 * back control.
 *
 * Hidden on the bottom-tab root destinations — true native apps don't show a
 * back chevron on a primary tab. Everywhere else it goes back in history, and
 * falls back to the parent route when the screen was deep-linked (no history).
 */
const ROOT_PATHS = new Set([
  '/',
  '/digital',
  '/trading',
  '/orders',
  '/agent',
  '/crm',
  '/digital/clients',
  '/employees',
  '/trading/hr',
  '/portal',
])

const NO_BACK_PREFIXES = ['/login', '/forgot-password', '/reset-password', '/invoice/share']

function parentPath(pathname: string): string {
  const parent = pathname.replace(/\/+$/, '').split('/').slice(0, -1).join('/')
  return parent === '' ? '/' : parent
}

export function shouldShowBack(pathname: string): boolean {
  if (!pathname) return false
  if (ROOT_PATHS.has(pathname)) return false
  if (NO_BACK_PREFIXES.some(p => pathname.startsWith(p))) return false
  return true
}

export function PageBackButton({
  className,
  fallbackHref,
  label = 'পিছনে',
  force = false,
}: {
  className?: string
  /** Where to go when the screen was deep-linked (no in-app history). */
  fallbackHref?: string
  label?: string
  /** Render even on root paths — for full-screen flows that always want a back. */
  force?: boolean
}) {
  const pathname = usePathname() ?? ''
  const router = useRouter()

  if (!force && !shouldShowBack(pathname)) return null

  const goBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back()
      return
    }
    router.push(fallbackHref ?? parentPath(pathname))
  }

  return (
    <button
      type="button"
      onClick={goBack}
      aria-label={label}
      className={cn(
        'alma-frost alma-pod inline-flex h-9 w-9 shrink-0 items-center justify-center text-cream',
        'transition-transform active:scale-95',
        className,
      )}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M15 18l-6-6 6-6"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}
