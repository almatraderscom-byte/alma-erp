'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { isNativeSttEnabled, setNativeSttEnabled } from '@/lib/native-speech'
import { isCapacitorNative } from '@/lib/capacitor-native'

/**
 * Owner setting (Phase N2): toggle ON-DEVICE speech-to-text for voice input.
 *
 * When ON, the iOS app transcribes dictation on-device (free + offline) via
 * NativeSpeechBridge, falling back to Whisper when unavailable. Default OFF so the
 * owner A/B-tests Bangla accuracy first. The flag is a plain localStorage value
 * (`alma_native_stt`) read by src/lib/native-speech.ts — no server round-trip.
 *
 * Only meaningful inside the iOS app (build ≥ 10). On the web/desktop the flag has
 * no effect (there is no native plugin), which the copy makes clear.
 */
export default function AgentVoiceSettings() {
  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [native, setNative] = useState(false)

  useEffect(() => {
    setEnabled(isNativeSttEnabled())
    setNative(isCapacitorNative())
  }, [])

  function toggle() {
    const next = !enabled
    setNativeSttEnabled(next)
    setEnabled(next)
  }

  return (
    <div className="rounded-xl border border-border-subtle bg-card/80 overflow-hidden shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-bold text-cream hover:bg-white/[0.02] transition-colors"
      >
        <span>🎙️ অন-ডিভাইস ভয়েস (STT)</span>
        <span className={cn(
          'text-[#E07A5F] transition-transform duration-200',
          open && 'rotate-180',
        )}>▼</span>
      </button>

      {open && (
        <div className="border-t border-border-subtle px-4 py-4">
          <p className="mb-4 text-[10px] text-muted leading-relaxed">
            চালু করলে iPhone অ্যাপ ভয়েস ইনপুট <b>অন-ডিভাইসে</b> লিখবে — ফ্রি, অফলাইন, Whisper API খরচ ছাড়া।
            মডেল না পারলে নিজে থেকেই Whisper-এ ফিরে যাবে। বাংলা কেমন হয় দেখে সিদ্ধান্ত নিন
            (build 10+ লাগবে)।
          </p>

          <label className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.02] px-3 py-2.5">
            <span className="text-xs font-semibold text-cream">
              অন-ডিভাইস ট্রান্সক্রিপশন
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={toggle}
              className={cn(
                'relative h-6 w-11 shrink-0 rounded-full transition-colors',
                enabled ? 'bg-emerald-500/80' : 'bg-white/15',
              )}
            >
              <span
                className={cn(
                  'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
                  enabled ? 'left-[22px]' : 'left-0.5',
                )}
              />
            </button>
          </label>

          <p className="mt-3 text-[10px] text-muted">
            {enabled ? '✓ চালু' : 'বন্ধ'}
            {!native && ' · (শুধু iPhone অ্যাপে কাজ করে — এখন ব্রাউজারে চলছে)'}
          </p>
        </div>
      )}
    </div>
  )
}
