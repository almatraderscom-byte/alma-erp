'use client'

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { APP_BUILD_ID, formatBuildLabel, type BuildInfo } from '@/lib/runtime-build'
import { isMeaningfulBuildId, isUpdateAvailable } from '@/lib/app-update'

/**
 * Tap-friendly production version pill — shows what's live vs what you're viewing.
 * Helps after deploys when the PWA cache serves an older bundle.
 */
export function AgentBuildBadge() {
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
          <p className="font-bold text-slate-800 mb-1.5">Deploy info</p>
          {lines.map((line) => (
            <p key={line} className="text-slate-600 break-words">{line}</p>
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

  return (
    <button
      type="button"
      onClick={showDetails}
      title="Tap for deploy details — bookmark /api/build-info"
      className={`hidden shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-semibold tabular-nums transition-colors sm:inline-flex ${
        stale
          ? 'border-amber-300 bg-amber-50 text-amber-800 animate-pulse'
          : 'border-black/[0.06] bg-slate-50 text-slate-500 hover:bg-slate-100 hover:text-slate-700'
      }`}
    >
      {stale ? '↻ ' : ''}{label}
    </button>
  )
}
