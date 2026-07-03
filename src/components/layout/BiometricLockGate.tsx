'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { App as CapApp } from '@capacitor/app'
import {
  biometricLockPlatform,
  biometryAvailable,
  isBiometricLockEnabled,
  runBiometricUnlock,
} from '@/lib/biometric-lock'

/**
 * Face ID / Touch ID lock screen for the native iOS shell.
 *
 * Mounted once from GlobalPlatformChrome. On iOS native (only), when the lock is
 * enabled and the device actually has biometry/passcode, it covers the whole app
 * with an opaque unlock screen:
 *   - on cold start, and
 *   - whenever the app returns to the foreground after being backgrounded for
 *     more than RELOCK_AFTER_MS (so a quick tab-away doesn't nag).
 *
 * Fail-open everywhere: web, Android, lock disabled, no biometry, or any plugin
 * error → renders nothing and never blocks. A cancelled/failed scan keeps the
 * lock up with a retry button (iOS itself offers the passcode fallback), so the
 * owner can never be permanently locked out.
 */

const RELOCK_AFTER_MS = 60_000

/**
 * Native builds below this number ship WITHOUT NSFaceIDUsageDescription in
 * Info.plist — on those, invoking Face ID makes iOS kill the app instantly
 * (TCC privacy violation; the 2026-07-03 build-2 crash). The web code deploys
 * to every existing install, so we must never arm the lock on an old binary.
 */
const MIN_NATIVE_BUILD = 4

async function nativeBuildNumber(): Promise<number | null> {
  try {
    const info = await CapApp.getInfo()
    const build = parseInt(String(info?.build ?? ''), 10)
    return Number.isFinite(build) ? build : null
  } catch {
    return null
  }
}

export function BiometricLockGate() {
  const [armed, setArmed] = useState(false) // feature usable on this device?
  const [locked, setLocked] = useState(false)
  const [prompting, setPrompting] = useState(false)
  const backgroundedAt = useRef<number | null>(null)

  const attemptUnlock = useCallback(async () => {
    setPrompting(true)
    const result = await runBiometricUnlock()
    setPrompting(false)
    if (result === 'unlocked' || result === 'unavailable') {
      // 'unavailable' → fail open (nothing to authenticate against).
      setLocked(false)
    }
    // 'cancelled' → stay locked, user taps retry.
  }, [])

  // One-time capability check, then lock on cold start if armed.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!biometricLockPlatform() || !isBiometricLockEnabled()) return
      // Hard safety: never arm on a binary that lacks the Face ID plist key.
      const build = await nativeBuildNumber()
      if (build == null || build < MIN_NATIVE_BUILD) return
      const ok = await biometryAvailable()
      if (cancelled || !ok) return
      setArmed(true)
      setLocked(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Re-lock on resume after a long background.
  useEffect(() => {
    if (!armed) return
    let pauseHandle: { remove: () => void } | undefined
    let resumeHandle: { remove: () => void } | undefined
    void (async () => {
      pauseHandle = await CapApp.addListener('pause', () => {
        backgroundedAt.current = Date.now()
      })
      resumeHandle = await CapApp.addListener('resume', () => {
        const since = backgroundedAt.current
        backgroundedAt.current = null
        if (isBiometricLockEnabled() && since != null && Date.now() - since > RELOCK_AFTER_MS) {
          setLocked(true)
        }
      })
    })()
    return () => {
      pauseHandle?.remove()
      resumeHandle?.remove()
    }
  }, [armed])

  // Auto-present Face ID the moment the lock goes up.
  useEffect(() => {
    if (locked && !prompting) void attemptUnlock()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked])

  if (!locked) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[2147483646] flex items-center justify-center bg-[#0c0b12] px-6 text-cream"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-gold-dim/45 bg-gold/10 text-xl font-black text-gold-lt">
          A
        </div>
        <div className="space-y-2">
          <p className="text-[11px] font-black tracking-[0.2em] text-gold">ALMA ERP</p>
          <h1 className="text-lg font-bold">অ্যাপ লক করা আছে</h1>
          <p className="text-sm text-muted">
            {prompting
              ? 'Face ID যাচাই করা হচ্ছে…'
              : 'চালিয়ে যেতে Face ID / Touch ID দিয়ে আনলক করুন।'}
          </p>
        </div>
        {!prompting && (
          <button
            type="button"
            onClick={() => void attemptUnlock()}
            className="w-full rounded-xl border border-gold-dim/50 bg-gold/20 px-4 py-3.5 text-sm font-extrabold text-gold-lt active:scale-[0.98]"
          >
            আনলক করুন
          </button>
        )}
      </div>
    </div>
  )
}
