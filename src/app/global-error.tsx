'use client'

import { useEffect } from 'react'
import { captureHydrationError, captureException } from '@/lib/sentry/capture'
import { clearAppCaches } from '@/lib/app-update'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    const msg = error.message || ''
    const isHydration =
      msg.includes('Hydration') ||
      msg.includes('hydration') ||
      msg.includes('Text content does not match') ||
      msg.includes('did not match')
    if (isHydration) {
      void captureHydrationError(error, { digest: error.digest })
    } else {
      void captureException(error, {
        category: 'client',
        event: 'react.global_error',
        critical: true,
        extra: { digest: error.digest },
      })
    }
  }, [error])

  async function hardRefresh() {
    try {
      await clearAppCaches()
    } catch {
      // reload anyway
    }
    window.location.href = '/'
  }

  return (
    <html lang="en">
      <body className="min-h-[100dvh] bg-black text-cream flex items-center justify-center p-6">
        <div className="max-w-md space-y-4 text-center">
          <p className="text-[10px] font-black uppercase tracking-widest text-amber-400">অ্যাপ ত্রুটি</p>
          <h1 className="text-lg font-semibold">কিছু একটা ভুল হয়েছে</h1>
          <p className="text-sm text-zinc-400">
            সমস্যাটি রিপোর্ট হয়েছে। নিচের বাটনে ক্লিক করে আবার চেষ্টা করুন।
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => reset()}
              className="rounded-xl border border-gold-dim/50 bg-gold/10 px-4 py-2 text-sm font-semibold text-gold-lt"
            >
              আবার চেষ্টা
            </button>
            <button
              type="button"
              onClick={() => void hardRefresh()}
              className="rounded-xl border border-border bg-white/[0.04] px-4 py-2 text-sm font-semibold text-zinc-300"
            >
              ক্যাশ মুছে রিফ্রেশ
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
