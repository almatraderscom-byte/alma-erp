'use client'
import { useState, useEffect } from 'react'

type Status = 'checking' | 'live' | 'error'

export function ConnectionStatus() {
  const [status,  setStatus]  = useState<Status>('checking')
  const [latency, setLatency] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const check = () => {
      const t0 = Date.now()
      fetch('/api/health', { cache: 'no-store' })
        .then(r => {
          if (cancelled) return
          setLatency(Date.now() - t0)
          if (r.ok) {
            failures = 0
            setStatus('live')
            return
          }
          failures += 1
          if (failures >= 2) setStatus('error')
          else timer = setTimeout(check, 5_000)
        })
        .catch(() => {
          if (cancelled) return
          failures += 1
          if (failures >= 2 || navigator.onLine === false) setStatus('error')
          else timer = setTimeout(check, 5_000)
        })
    }

    timer = setTimeout(check, 1_000)
    const recover = () => {
      failures = 0
      setStatus('checking')
      if (timer) clearTimeout(timer)
      timer = setTimeout(check, 1_000)
    }
    window.addEventListener('online', recover)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      window.removeEventListener('online', recover)
    }
  }, [])

  if (status === 'checking') {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
        <span className="w-1.5 h-1.5 rounded-full bg-white/[0.04]0 animate-pulse" />
        <span className="text-[10px] text-muted font-semibold">Connecting…</span>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-400/5 border border-red-400/20"
        title="Cannot reach ERP API — check network or deployment"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
        <span className="text-[10px] text-red-400 font-semibold">Offline</span>
      </div>
    )
  }

  return (
    <div
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-400/5 border border-green-400/15"
      title={`Live · Postgres${latency ? ` · ${latency}ms` : ''}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
      <span className="text-[10px] text-green-400 font-semibold">
        Live{latency ? ` · ${latency}ms` : ''}
      </span>
    </div>
  )
}
