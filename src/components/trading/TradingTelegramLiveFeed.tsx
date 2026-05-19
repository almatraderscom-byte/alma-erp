'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, Skeleton } from '@/components/ui'
import { EmployeeAvatar } from '@/components/profile/EmployeeAvatar'
import type { TradingTelegramLiveFeed } from '@/types/trading-telegram'

const POLL_MS = 8000

export function TradingTelegramLiveFeed() {
  const [feed, setFeed] = useState<TradingTelegramLiveFeed | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sinceRef = useRef<string | undefined>(undefined)

  const load = useCallback(async (incremental: boolean) => {
    try {
      const qs = incremental && sinceRef.current ? `?since=${encodeURIComponent(sinceRef.current)}` : '?limit=40'
      const res = await fetch(`/api/trading/telegram/live${qs}`)
      const data = (await res.json()) as TradingTelegramLiveFeed & { error?: string }
      if (!res.ok) {
        setError(data.error || 'Failed to load live feed')
        return
      }
      setError(null)
      setFeed(prev => {
        if (!incremental || !prev) return data
        const draftIds = new Set(prev.drafts.map(d => d.id))
        const auditIds = new Set(prev.audits.map(a => a.id))
        const newDrafts = data.drafts.filter(d => !draftIds.has(d.id))
        const newAudits = data.audits.filter(a => !auditIds.has(a.id))
        return {
          ...data,
          drafts: [...newDrafts, ...prev.drafts].slice(0, 50),
          audits: [...newAudits, ...prev.audits].slice(0, 30),
        }
      })
      sinceRef.current = data.serverTime
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void load(false)
    const id = window.setInterval(() => void load(true), POLL_MS)
    return () => window.clearInterval(id)
  }, [load])

  if (!feed && !error) return <Skeleton className="h-48 w-full" />

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-300">{error}</p>}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[
          ['Pending', feed?.counts.pending ?? 0, 'text-amber-200'],
          ['Locked', feed?.counts.locked ?? 0, 'text-orange-300'],
          ['Posted', feed?.counts.posted ?? 0, 'text-emerald-300'],
          ['Rejected', feed?.counts.rejected ?? 0, 'text-red-300'],
          ['Undone', feed?.counts.undone ?? 0, 'text-zinc-400'],
        ].map(([label, n, cls]) => (
          <Card key={label} className="p-2 text-center">
            <p className={`text-lg font-black ${cls}`}>{n}</p>
            <p className="text-[10px] uppercase text-zinc-500">{label}</p>
          </Card>
        ))}
      </div>

      <p className="text-[10px] text-zinc-500">Polling every {POLL_MS / 1000}s · Super admin live view</p>

      <Card className="p-3">
        <p className="mb-2 text-xs font-bold uppercase text-zinc-500">Latest trades</p>
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {!feed?.drafts.length ? (
            <p className="text-xs text-zinc-500">No recent drafts</p>
          ) : (
            feed.drafts.map(d => (
              <div key={d.id} className="flex gap-2 rounded-lg bg-black/30 p-2 text-xs">
                <EmployeeAvatar
                  userId={d.user?.id}
                  name={d.user?.name}
                  imageUrl={d.user?.profileImageUrl}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-cream">
                    {d.tradeNumber != null ? `#${d.tradeNumber} · ` : ''}
                    {d.tradeType} {String(d.usdtAmount)} USDT
                    <span className="ml-2 text-zinc-500">{d.status}</span>
                  </p>
                  <p className="text-zinc-400">
                    {d.user?.name || '—'} · @{d.telegramUsername || d.telegramUserId}
                  </p>
                  <p className="text-zinc-500">{d.accountTitle || d.accountAlias || '—'}</p>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>

      <Card className="p-3">
        <p className="mb-2 text-xs font-bold uppercase text-zinc-500">Events (duplicates · undo)</p>
        <div className="max-h-40 space-y-2 overflow-y-auto">
          {!feed?.audits.length ? (
            <p className="text-xs text-zinc-500">No recent events</p>
          ) : (
            feed.audits.map(a => (
              <div key={a.id} className="rounded-lg bg-black/20 p-2 text-[11px] text-zinc-300">
                <span className="font-bold text-gold-lt">{a.eventType}</span>
                {' · '}
                @{a.telegramUsername || a.telegramUserId}
                {a.detail ? ` — ${a.detail}` : ''}
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  )
}
