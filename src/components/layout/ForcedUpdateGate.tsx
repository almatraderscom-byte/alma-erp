'use client'

import { useEffect, useState } from 'react'
import { fetchWithTimeout } from '@/lib/fetch-timeout'

/**
 * Hard forced-update gate for the native Android app.
 *
 * The shell loads the LIVE site inside the WebView, so this gate ships to every
 * existing install the moment it deploys — no new APK needed to ACTIVATE the
 * gate. On Android-native only, it reads the installed APK versionCode via the
 * @capacitor/app plugin and compares it against the owner-tunable minimum from
 * /api/app/native-version. If the install is too old it covers the whole screen
 * with a blocking download prompt so staff cannot use a stale build.
 *
 * Fail-open by design: web, iOS, an unreadable version, or any network/plugin
 * error leaves the app fully usable. Only a KNOWN Android build strictly below
 * the configured minimum is ever blocked.
 */

type CapacitorGlobal = {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
  Plugins?: {
    App?: { getInfo?: () => Promise<{ build?: string; version?: string }> }
  }
}

async function getInstalledAndroidBuild(): Promise<number | null> {
  if (typeof window === 'undefined') return null
  const cap = (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor
  if (!cap?.isNativePlatform?.()) return null
  if (cap.getPlatform?.() !== 'android') return null
  const appPlugin = cap.Plugins?.App
  if (!appPlugin?.getInfo) return null
  try {
    const info = await appPlugin.getInfo()
    const build = parseInt(String(info?.build ?? ''), 10)
    return Number.isFinite(build) ? build : null
  } catch {
    return null
  }
}

export function ForcedUpdateGate() {
  const [blocked, setBlocked] = useState(false)
  const [apkUrl, setApkUrl] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const installed = await getInstalledAndroidBuild()
      if (installed == null) return // web / iOS / unknown → never block
      try {
        const res = await fetchWithTimeout('/api/app/native-version', { cache: 'no-store' }, 8_000)
        if (!res.ok) return
        const json = await res.json().catch(() => null)
        const minBuild = Number(json?.minBuild) || 0
        const url = String(json?.apkUrl || '')
        if (minBuild > 0 && url && installed < minBuild) {
          if (cancelled) return
          setApkUrl(url)
          setBlocked(true)
        }
      } catch {
        /* fail-open: a check failure must never block a working app */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!blocked) return null

  const onDownload = () => {
    // Off-domain URL → Capacitor punts window.open('_blank') to the system
    // browser, whose download manager fetches the APK.
    if (apkUrl) window.open(apkUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      // Max 32-bit z-index so this sits above every modal, toast, and overlay.
      className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-black px-6 text-cream"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="w-full max-w-sm space-y-5 text-center">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-gold-dim/45 bg-gold/10 text-xl font-black text-gold-lt">
          A
        </div>
        <div className="space-y-2">
          <p className="text-[11px] font-black tracking-[0.2em] text-gold">ALMA ERP</p>
          <h1 className="text-lg font-bold">নতুন আপডেট আবশ্যক</h1>
          <p className="text-sm text-muted">
            অ্যাপের নতুন ভার্সন বের হয়েছে। চালিয়ে যেতে এখনই আপডেট করুন — পুরোনো ভার্সনে আর কাজ করবে না।
          </p>
        </div>
        <button
          type="button"
          onClick={onDownload}
          className="w-full rounded-xl border border-gold-dim/50 bg-gold/20 px-4 py-3.5 text-sm font-extrabold text-gold-lt active:scale-[0.98]"
        >
          নতুন ভার্সন ডাউনলোড করুন
        </button>
        <p className="text-xs text-muted">
          ডাউনলোড শেষে ফাইলে ট্যাপ করে Install করুন, তারপর অ্যাপ আবার খুলুন।
        </p>
      </div>
    </div>
  )
}
