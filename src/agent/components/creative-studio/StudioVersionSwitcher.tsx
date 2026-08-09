'use client'

import { useSyncExternalStore, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { isNativeShell } from '@/lib/native-shell'
import {
  STUDIO_WEB_VERSION_COOKIE,
  STUDIO_WEB_VERSION_COOKIE_MAX_AGE_SECONDS,
  type StudioWebVersion,
} from '@/agent/components/creative-studio/studio-version'

function persistVersion(version: StudioWebVersion) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = [
    `${STUDIO_WEB_VERSION_COOKIE}=${version}`,
    'Path=/agent/creative-studio',
    `Max-Age=${STUDIO_WEB_VERSION_COOKIE_MAX_AGE_SECONDS}`,
    'SameSite=Lax',
  ].join('; ') + secure
}

function subscribeToNativeShell() {
  return () => {}
}

export function StudioVersionSwitcher({
  activeVersion,
  canUseV4,
  disabled = false,
  legacyHref,
  tone,
  v4Href,
}: {
  activeVersion: StudioWebVersion
  canUseV4: boolean
  disabled?: boolean
  legacyHref?: string
  tone: 'light' | 'dark'
  v4Href?: string
}) {
  const router = useRouter()
  const nativeShell = useSyncExternalStore(
    subscribeToNativeShell,
    isNativeShell,
    () => true,
  )
  const [isPending, startTransition] = useTransition()

  if (nativeShell || !canUseV4) return null

  const switchVersion = (version: StudioWebVersion) => {
    if (disabled || isPending || version === activeVersion) return
    persistVersion(version)

    const current = new URL(window.location.href)
    const configuredHref = version === 'legacy' ? legacyHref : v4Href
    const href = configuredHref
      ? configuredHref
      : (() => {
          current.searchParams.set('studio', version)
          return `${current.pathname}?${current.searchParams.toString()}${current.hash}`
        })()
    startTransition(() => router.replace(href, { scroll: false }))
  }

  const option = (version: StudioWebVersion, fullLabel: string, shortLabel: string) => {
    const active = activeVersion === version
    return (
      <button
        aria-pressed={active}
        className={cn(
          'min-h-7 rounded-full px-2.5 text-[10px] font-extrabold transition-colors sm:min-h-8 sm:px-3 sm:text-[11px]',
          active && tone === 'light' && 'bg-[#ad472d] text-white shadow-sm',
          active && tone === 'dark' && 'bg-[#E07A5F] text-white shadow-sm',
          !active && tone === 'light' && 'text-[#6f625d] hover:bg-black/[0.05] hover:text-[#201b19]',
          !active && tone === 'dark' && 'text-muted hover:bg-white/10 hover:text-cream',
          (disabled || isPending) && 'cursor-not-allowed opacity-60',
        )}
        disabled={disabled || isPending}
        key={version}
        onClick={() => switchVersion(version)}
        type="button"
      >
        <span className="hidden sm:inline">{fullLabel}</span>
        <span className="sm:hidden">{shortLabel}</span>
      </button>
    )
  }

  return (
    <div
      aria-label="Creative Studio web version"
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full border p-0.5',
        tone === 'light'
          ? 'border-black/10 bg-white/75'
          : 'border-white/10 bg-black/25',
      )}
      role="group"
      title={disabled ? 'Exit the editor before switching versions' : 'Switch Creative Studio web version'}
    >
      {option('v4', 'V4 নতুন', 'V4')}
      {option('legacy', 'আগের ভার্সন', 'আগের')}
    </div>
  )
}
