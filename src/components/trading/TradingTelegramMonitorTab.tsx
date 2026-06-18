'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Skeleton } from '@/components/ui'
import { TradingTelegramLiveFeed } from '@/components/trading/TradingTelegramLiveFeed'

type MonitorPayload = {
  pendingDeleteApprovals: number
  staffSummaries: Array<{ userId: string; name: string; role: string | null; pendingCount: number }>
  suspiciousAudits: Array<{
    id: string
    eventType: string
    telegramUserId: string | null
    telegramUsername: string | null
    rawMessage: string | null
    detail: string | null
    createdAt: string
  }>
  draftCounts: Record<string, number>
  serverTime: string
}

export function TradingTelegramMonitorTab({
  isSuperAdmin,
}: {
  isSuperAdmin: boolean
}) {
  const [data, setData] = useState<MonitorPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/trading/telegram/monitor')
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to load monitor')
      setData(json)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (loading) return <Skeleton className="h-48 w-full" />
  if (error) return <p className="text-sm text-red-300">{error}</p>
  if (!data) return null

  return (
    <div className="space-y-4">
      <Card className="border-gold-dim/30 bg-gold/5 p-4">
        <p className="text-sm font-black text-cream">Owner monitoring</p>
        <p className="mt-1 text-xs text-muted">
          Observe staff confirmations and risk signals. Daily accounting is done by each trader on their own drafts.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted">Pending deletes</p>
            <p className="text-2xl font-black text-amber-300">{data.pendingDeleteApprovals}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted">Pending drafts (all)</p>
            <p className="text-2xl font-black text-cream">
              {(data.draftCounts.PENDING ?? 0) + (data.draftCounts.LOCKED ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted">Posted today (queue)</p>
            <p className="text-2xl font-black text-green-400">{data.draftCounts.POSTED ?? 0}</p>
          </div>
        </div>
        <Button variant="ghost" size="sm" className="mt-3" onClick={() => void load()}>
          Refresh
        </Button>
      </Card>

      <Card className="p-4">
        <p className="mb-3 text-xs font-bold uppercase tracking-wider text-muted">Staff pending by user</p>
        {!data.staffSummaries.length ? (
          <p className="text-xs text-muted-hi">No pending drafts across staff.</p>
        ) : (
          <div className="divide-y divide-border">
            {data.staffSummaries.map(s => (
              <div key={s.userId} className="flex justify-between gap-3 py-2 text-xs">
                <span className="text-cream">{s.name}</span>
                <span className="font-bold text-amber-300">{s.pendingCount} pending</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-4">
        <p className="mb-3 text-xs font-bold uppercase tracking-wider text-muted">Suspicious bot activity</p>
        {!data.suspiciousAudits.length ? (
          <p className="text-xs text-muted-hi">No recent alerts.</p>
        ) : (
          <div className="max-h-48 space-y-2 overflow-y-auto">
            {data.suspiciousAudits.map(a => (
              <div key={a.id} className="rounded-lg bg-white/[0.03] p-2 text-[11px]">
                <p className="font-bold text-amber-200">{a.eventType}</p>
                <p className="text-muted">{a.detail || a.rawMessage || '—'}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      {isSuperAdmin && (
        <div>
          <p className="mb-2 text-xs font-bold uppercase tracking-wider text-muted">Live operational feed</p>
          <TradingTelegramLiveFeed />
        </div>
      )}
    </div>
  )
}
