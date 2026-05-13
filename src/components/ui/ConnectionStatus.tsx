'use client'
import { useState, useEffect } from 'react'

type Status = 'checking' | 'live' | 'error'

export function ConnectionStatus() {
  const [status,  setStatus]  = useState<Status>('checking')
  const [latency, setLatency] = useState<number | null>(null)

  useEffect(() => {
    const t0 = Date.now()
    fetch('/api/dashboard')
      .then(r => { setLatency(Date.now() - t0); setStatus(r.ok ? 'live' : 'error') })
      .catch(() => setStatus('error'))
  }, [])

  if (status === 'checking') {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse" />
        <span className="text-[10px] text-zinc-500 font-semibold">Connecting…</span>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-400/5 border border-red-400/20"
        title="Cannot reach Google Sheets API — check NEXT_PUBLIC_API_URL"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
        <span className="text-[10px] text-red-400 font-semibold">Offline</span>
      </div>
    )
  }

  return (
    <div
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-400/5 border border-green-400/15"
      title={`Live · Google Sheets${latency ? ` · ${latency}ms` : ''}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
      <span className="text-[10px] text-green-400 font-semibold">
        Live{latency ? ` · ${latency}ms` : ''}
      </span>
    </div>
  )
}
