'use client'

import { useEffect, useState } from 'react'
import { Card } from '@/components/ui'
import {
  biometricLockPlatform,
  isBiometricLockEnabled,
  setBiometricLockEnabled,
} from '@/lib/biometric-lock'

/**
 * Owner-facing toggle for the iOS Face ID app lock. Renders ONLY inside the
 * native iOS shell (biometricLockPlatform) — invisible on web/Android where the
 * feature does not apply. Preference is stored locally; takes effect on the next
 * lock check (cold start or resume-after-idle).
 */
export function BiometricLockToggle() {
  const [show, setShow] = useState(false)
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    if (!biometricLockPlatform()) return
    setShow(true)
    setEnabled(isBiometricLockEnabled())
  }, [])

  if (!show) return null

  function toggle(next: boolean) {
    setBiometricLockEnabled(next)
    setEnabled(next)
  }

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-cream">অ্যাপ লক (Face ID)</p>
          <p className="text-[11px] text-muted mt-1">
            অ্যাপ খুললে বা কিছুক্ষণ পর ফিরে এলে Face ID / Touch ID দিয়ে আনলক করতে হবে।
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => toggle(!enabled)}
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
            enabled ? 'bg-gold/70' : 'bg-white/15'
          }`}
        >
          <span
            className={`absolute top-1 h-5 w-5 rounded-full bg-cream transition-transform ${
              enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>
    </Card>
  )
}
