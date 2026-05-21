'use client'

import { useEffect } from 'react'
import { captureException } from '@/lib/sentry/capture'
import { Button, Card } from '@/components/ui'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    void captureException(error, {
      category: 'client',
      event: 'react.route_error',
      critical: true,
      extra: { digest: error.digest },
    })
  }, [error])

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <Card className="max-w-md p-6 space-y-4 text-center border-amber-500/20">
        <p className="text-[10px] font-black uppercase tracking-widest text-amber-400">Page error</p>
        <p className="text-sm text-zinc-400">This section failed to load. The error was reported automatically.</p>
        <div className="flex justify-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => reset()}>
            Retry
          </Button>
          <Button size="sm" onClick={() => { window.location.href = '/' }}>
            Home
          </Button>
        </div>
      </Card>
    </div>
  )
}
