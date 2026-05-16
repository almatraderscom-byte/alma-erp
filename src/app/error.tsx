'use client'

import { useEffect } from 'react'
import { Button, Card } from '@/components/ui'

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[app-error]', error)
  }, [error])

  return (
    <div className="min-h-[100dvh] bg-black p-6 flex items-center justify-center">
      <Card className="max-w-lg w-full p-6 border-red-500/30">
        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-red-400">Runtime error</p>
        <h1 className="mt-2 text-lg font-bold text-cream">Something went wrong</h1>
        <p className="mt-2 text-xs text-zinc-500 leading-relaxed">
          The ERP shell stayed online. Retry the view; if it repeats, check `/api/health` and recent server logs.
        </p>
        <p className="mt-3 rounded-xl border border-border bg-black/30 p-3 font-mono text-[10px] text-zinc-500">
          {error.digest || error.message}
        </p>
        <Button variant="gold" className="mt-4" onClick={reset}>Try again</Button>
      </Card>
    </div>
  )
}
