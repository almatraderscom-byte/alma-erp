'use client'

import { useEffect, useState } from 'react'
import { isCapacitorNative } from '@/lib/capacitor-native'

/**
 * Android app-update nudge. The APK is sideloaded from /app/download (no Play
 * Store auto-update), so staff phones silently stay on old builds — including
 * the pre-Firebase ones that can never receive a push with the app closed.
 * Any native Android build older than MIN_ANDROID_BUILD gets a dismissible
 * Bangla banner pointing at the download page. iOS updates ride TestFlight, so
 * this renders nothing there.
 */
const MIN_ANDROID_BUILD = 5
const DISMISS_KEY = 'alma_update_nudge_dismissed_at'
const DISMISS_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000 // re-surface every 3 days

export function NativeUpdateNudge() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (!isCapacitorNative()) return
    let cancelled = false
    void (async () => {
      try {
        const { Capacitor } = await import('@capacitor/core')
        if (Capacitor.getPlatform() !== 'android') return
        const { App } = await import('@capacitor/app')
        const info = await App.getInfo()
        const build = parseInt(String(info?.build ?? ''), 10)
        if (!Number.isFinite(build) || build >= MIN_ANDROID_BUILD) return
        const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) || 0)
        if (dismissedAt && Date.now() - dismissedAt < DISMISS_COOLDOWN_MS) return
        if (!cancelled) setShow(true)
      } catch {
        // Info unavailable (very old binary) — stay quiet rather than nag wrongly.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!show) return null

  return (
    <div className="fixed inset-x-3 top-[calc(0.75rem+env(safe-area-inset-top,0px))] z-[230] mx-auto max-w-md rounded-2xl border border-gold-dim/40 bg-[#09090d]/95 p-3 text-cream shadow-2xl shadow-black/60">
      <p className="text-sm font-black">নতুন Alma ERP অ্যাপ এসেছে</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        আপনার অ্যাপটি পুরনো ভার্সনে চলছে — অ্যাপ বন্ধ থাকলে notification আসবে না। নতুন ভার্সন install করুন।
      </p>
      <div className="mt-2 flex gap-2">
        <a
          href="/app/download"
          className="rounded-xl border border-gold-dim/50 bg-gold/15 px-3 py-2 text-[11px] font-black text-gold-lt active:scale-[0.98]"
        >
          আপডেট করুন
        </a>
        <button
          type="button"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, String(Date.now()))
            setShow(false)
          }}
          className="rounded-xl border border-border bg-white/[0.04] px-3 py-2 text-[11px] font-bold text-muted active:scale-[0.98]"
        >
          পরে
        </button>
      </div>
    </div>
  )
}
