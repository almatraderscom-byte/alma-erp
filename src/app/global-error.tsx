'use client'

import { useEffect } from 'react'
import { captureHydrationError, captureException } from '@/lib/sentry/capture'

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

  return (
    <html lang="en">
      <body className="min-h-[100dvh] bg-black text-cream flex items-center justify-center p-6">
        <div className="max-w-md space-y-4 text-center">
          <p className="text-[10px] font-black uppercase tracking-widest text-amber-400">Application error</p>
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-zinc-400">
            The error was reported automatically. Try again or return to the dashboard.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-xl border border-gold-dim/50 bg-gold/10 px-4 py-2 text-sm font-semibold text-gold-lt"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
