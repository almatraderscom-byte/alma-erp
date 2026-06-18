'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { APP_BUILD_ID, formatBuildLabel, type BuildInfo } from '@/lib/runtime-build'
import { isMeaningfulBuildId, isUpdateAvailable } from '@/lib/app-update'
import { cn } from '@/lib/utils'

type AgentBuildBadgeProps = {
  /** monitor = full-width top banner with entrance animation */
  variant?: 'inline' | 'monitor'
  className?: string
}

/**
 * Tap-friendly production version pill — shows what's live vs what you're viewing.
 */
export function AgentBuildBadge({ variant = 'inline', className }: AgentBuildBadgeProps) {
  const [remote, setRemote] = useState<BuildInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetch('/api/build-info', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: BuildInfo | null) => {
        if (!cancelled && json?.ok) setRemote(json)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const localShort = isMeaningfulBuildId(APP_BUILD_ID) ? APP_BUILD_ID.slice(0, 7) : 'local'
  const stale = isUpdateAvailable(APP_BUILD_ID, remote?.commit ?? null)

  const label = remote
    ? formatBuildLabel(remote)
    : `… · ${localShort}`

  const showDetails = useCallback(() => {
    const lines = [
      `Environment: ${remote?.environment ?? 'unknown'}`,
      `Live commit: ${remote?.commitShort ?? 'unknown'}`,
      remote?.message ? `Message: ${remote.message}` : null,
      remote?.branch ? `Branch: ${remote.branch}` : null,
      `Your screen: ${localShort}${stale ? ' (older — hard refresh recommended)' : ''}`,
      remote?.githubCommitUrl ? `GitHub: ${remote.githubCommitUrl}` : null,
    ].filter(Boolean)

    toast(
      (t) => (
        <div className="text-left text-xs leading-relaxed max-w-[min(90vw,320px)]">
          <p className="font-bold text-cream mb-1.5">Deploy info</p>
          {lines.map((line) => (
            <p key={line} className="text-muted-hi break-words">{line}</p>
          ))}
          <div className="mt-2 flex flex-wrap gap-2">
            {remote?.githubCommitUrl && (
              <a
                href={remote.githubCommitUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#E07A5F] font-semibold hover:underline"
                onClick={() => toast.dismiss(t.id)}
              >
                Open on GitHub
              </a>
            )}
            {stale && (
              <button
                type="button"
                className="text-emerald-700 font-semibold hover:underline"
                onClick={() => {
                  toast.dismiss(t.id)
                  window.location.reload()
                }}
              >
                Reload now
              </button>
            )}
          </div>
        </div>
      ),
      { duration: stale ? 12_000 : 8_000 },
    )
  }, [localShort, remote, stale])

  const pill = (
    <button
      type="button"
      onClick={showDetails}
      title="Tap for deploy details — bookmark /api/build-info"
      className={cn(
        'shrink-0 rounded-full border font-semibold tabular-nums transition-all duration-200',
        variant === 'monitor'
          ? 'inline-flex min-h-[32px] items-center gap-1.5 px-3.5 py-1 text-[11px]'
          : 'hidden px-2 py-0.5 text-[9px] sm:inline-flex',
        stale
          ? 'border-amber-300/60 bg-amber-400/12 text-amber-200 shadow-[0_0_14px_-2px_rgba(251,191,36,0.5)] animate-pulse'
          : 'border-white/10 bg-white/[0.04] text-cream/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] hover:border-[#E07A5F]/45 hover:bg-[#E07A5F]/10 hover:text-cream hover:shadow-[0_0_16px_-3px_rgba(224,122,95,0.55)]',
        className,
      )}
    >
      {stale ? '↻ ' : ''}{label}
    </button>
  )

  if (variant === 'monitor') {
    return (
      <motion.div
        initial={{ opacity: 0, y: -14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        className="mb-2.5 flex justify-center"
      >
        <div className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-card/82 px-2 py-1 shadow-[0_4px_20px_rgba(224,122,95,0.12)] backdrop-blur-sm">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#E07A5F] opacity-40" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[#E07A5F]" />
          </span>
          {pill}
        </div>
      </motion.div>
    )
  }

  return pill
}
