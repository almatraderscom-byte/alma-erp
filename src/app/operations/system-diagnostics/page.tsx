'use client'

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Button, Card, PageHeader, Skeleton } from '@/components/ui'
import { useBusiness } from '@/contexts/BusinessContext'
import { safeFetchJson } from '@/lib/safe-fetch'

type StatusCount = { status: string; count: number }

type DiagnosticsData = {
  generatedAt: string
  config: {
    botTokenConfigured: boolean
    cronSecretConfigured: boolean
    ownerChatIdsConfigured: boolean
    ownerChatIdsEnvFallback?: boolean
    ownerRoutingSource?: string
    ownerChatIdsCount?: number
    storageConfigured: boolean
  }
  telegramQueue: {
    byStatus: StatusCount[]
    pendingDepth: number
    stuckSending: number
    processingCount: number
    retryWaitCount: number
    failedDeadLetter?: number
    maxAttempts?: number
    oldestQueued: { id: string; eventType: string; ageMinutes: number } | null
    averageDeliveryLatencyMs: number | null
  }
  selfieStorage: {
    last24hTotal: number
    missingStorageRefCount: number
    recentLogs: Array<{
      id: string
      employeeId: string
      capturedAt: string
      sizeBytes: number
      storageType: 'supabase' | 'inline_base64' | 'unknown'
      reviewedAt: string | null
    }>
  }
  recentTelegramLogs: Array<{
    id: string
    eventType: string
    status: string
    attempts: number
    maxAttempts: number
    chatId: string
    createdAt: string
    sentAt: string | null
    errorMessage: string | null
    nextAttemptAt: string | null
    ageMinutes: number
  }>
}

function ConfigBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${
        ok
          ? 'border-green-500/30 bg-green-500/10 text-green-400'
          : 'border-red-500/30 bg-red-500/10 text-red-400'
      }`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${ok ? 'bg-green-400' : 'bg-red-400'}`} />
      {label}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    QUEUED: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    SENDING: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
    SENT: 'border-green-500/30 bg-green-500/10 text-green-400',
    FAILED: 'border-red-500/30 bg-red-500/10 text-red-400',
    SKIPPED: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-400',
  }
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-black uppercase ${map[status] ?? 'text-zinc-500'}`}>
      {status}
    </span>
  )
}

function StorageTypeBadge({ type }: { type: string }) {
  if (type === 'supabase') return <span className="text-green-400 font-bold">supabase ✓</span>
  if (type === 'inline_base64') return <span className="text-amber-400 font-bold">inline_base64 ⚠</span>
  return <span className="text-red-400 font-bold">unknown ✗</span>
}

export default function SystemDiagnosticsPage() {
  const { business } = useBusiness()
  const [data, setData] = useState<DiagnosticsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionBusy, setActionBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await safeFetchJson<DiagnosticsData>(
        `/api/operations/system-diagnostics?business_id=${encodeURIComponent(business.id)}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(res.error.message)
      setData(res.data as DiagnosticsData)
    } catch (e) {
      toast.error((e as Error).message || 'Could not load diagnostics')
    } finally {
      setLoading(false)
    }
  }, [business.id])

  useEffect(() => { void load() }, [load])

  async function runAction(action: string, label: string, extra?: object) {
    setActionBusy(true)
    try {
      const res = await safeFetchJson('/api/operations/system-diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id, action, ...extra }),
      })
      if (!res.ok) {
        toast.error((res.error as { message?: string })?.message || `${label} failed`)
        return
      }
      toast.success(`${label} complete`)
      void load()
    } catch (e) {
      toast.error((e as Error).message || `${label} failed`)
    } finally {
      setActionBusy(false)
    }
  }

  const q = data?.telegramQueue
  const s = data?.selfieStorage

  return (
    <div className="space-y-6 pb-16">
      <PageHeader
        title="System Diagnostics"
        subtitle="Read-only observability for Telegram queue and photo storage health. SUPER_ADMIN only."
        actions={
          <div className="flex gap-2">
            <Button size="xs" variant="ghost" onClick={() => void load()} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </Button>
          </div>
        }
      />

      {/* Config health */}
      <Card className="p-5 space-y-3">
        <p className="text-[11px] font-black uppercase tracking-widest text-zinc-500">System config</p>
        {loading ? (
          <Skeleton className="h-8" />
        ) : (
          <div className="flex flex-wrap gap-2">
            <ConfigBadge ok={data?.config.botTokenConfigured ?? false} label="Telegram Bot Token" />
            <ConfigBadge ok={data?.config.cronSecretConfigured ?? false} label="CRON_SECRET" />
            <ConfigBadge ok={data?.config.ownerChatIdsConfigured ?? false} label="Owner Chat IDs" />
            <ConfigBadge ok={data?.config.storageConfigured ?? false} label="Supabase Storage" />
          </div>
        )}
        {data && !data.config.cronSecretConfigured && (
          <p className="text-[11px] text-red-400 font-bold">
            ⚠ CRON_SECRET is not set — Vercel cron job will return 500 and no Telegram rows will be
            processed automatically. Set CRON_SECRET in Vercel environment variables.
          </p>
        )}
        {data && !data.config.botTokenConfigured && (
          <p className="text-[11px] text-red-400 font-bold">
            ⚠ TELEGRAM_BOT_TOKEN is missing — all deliveries will fail immediately.
          </p>
        )}
        {data && !data.config.ownerChatIdsConfigured && (
          <p className="text-[11px] text-red-400 font-bold">
            ⚠ No owner Telegram chat IDs (DB or TELEGRAM_OWNER_CHAT_IDS env) — check-in alerts are
            skipped at enqueue. Configure IDs in Settings → Telegram Ops.
          </p>
        )}
        {data?.config.ownerRoutingSource === 'disabled' && (
          <p className="text-[11px] text-amber-300 font-bold">
            ⚠ Telegram ops is disabled for this business — notifications will not enqueue.
          </p>
        )}
      </Card>

      {/* Telegram queue */}
      <Card className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-black uppercase tracking-widest text-zinc-500">Telegram queue</p>
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="secondary"
              disabled={actionBusy || loading}
              onClick={() => void runAction('process_queue', 'Process queue', { limit: 30 })}
            >
              Process now (30)
            </Button>
            <Button
              size="xs"
              variant="danger"
              disabled={actionBusy || loading}
              onClick={() => void runAction('retry_failed', 'Retry failed', { limit: 50 })}
            >
              Retry all failed
            </Button>
          </div>
        </div>

        {loading ? (
          <Skeleton className="h-24" />
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {(q?.byStatus ?? []).map(s => (
                <div key={s.status} className="rounded-xl border border-border bg-black/20 px-3 py-2">
                  <p className="text-[9px] uppercase tracking-wider text-zinc-600">{s.status}</p>
                  <p className="mt-0.5 font-mono text-lg font-black text-cream">{s.count}</p>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-[11px]">
              <div className="rounded-xl border border-border bg-black/20 px-3 py-2">
                <p className="text-zinc-600">Pending depth</p>
                <p className={`font-mono font-bold ${(q?.pendingDepth ?? 0) > 0 ? 'text-amber-300' : 'text-green-400'}`}>{q?.pendingDepth ?? 0}</p>
              </div>
              <div className="rounded-xl border border-border bg-black/20 px-3 py-2">
                <p className="text-zinc-600">Stuck sending</p>
                <p className={`font-mono font-bold ${(q?.stuckSending ?? 0) > 0 ? 'text-red-400' : 'text-green-400'}`}>{q?.stuckSending ?? 0}</p>
              </div>
              <div className="rounded-xl border border-border bg-black/20 px-3 py-2">
                <p className="text-zinc-600">Retry wait</p>
                <p className="font-mono font-bold text-cream">{q?.retryWaitCount ?? 0}</p>
              </div>
              <div className="rounded-xl border border-border bg-black/20 px-3 py-2">
                <p className="text-zinc-600">Dead letter (max attempts)</p>
                <p className={`font-mono font-bold ${(q?.failedDeadLetter ?? 0) > 0 ? 'text-red-400' : 'text-green-400'}`}>
                  {q?.failedDeadLetter ?? 0}
                  {q?.maxAttempts != null ? ` / ${q.maxAttempts}` : ''}
                </p>
              </div>
              <div className="rounded-xl border border-border bg-black/20 px-3 py-2">
                <p className="text-zinc-600">Avg delivery latency</p>
                <p className="font-mono font-bold text-cream">
                  {q?.averageDeliveryLatencyMs != null ? `${q.averageDeliveryLatencyMs}ms` : 'N/A'}
                </p>
              </div>
              <div className="rounded-xl border border-border bg-black/20 px-3 py-2 col-span-2">
                <p className="text-zinc-600">Oldest pending</p>
                {q?.oldestQueued ? (
                  <p className="font-mono font-bold text-amber-300">
                    {q.oldestQueued.eventType} · {q.oldestQueued.ageMinutes}min ago
                  </p>
                ) : (
                  <p className="font-mono font-bold text-green-400">None</p>
                )}
              </div>
            </div>
          </>
        )}
      </Card>

      {/* Selfie storage */}
      <Card className="p-5 space-y-4">
        <p className="text-[11px] font-black uppercase tracking-widest text-zinc-500">Selfie photo storage (last 24h)</p>
        {loading ? (
          <Skeleton className="h-16" />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-border bg-black/20 px-3 py-2">
                <p className="text-[9px] uppercase tracking-wider text-zinc-600">Total selfies</p>
                <p className="mt-0.5 font-mono text-lg font-black text-cream">{s?.last24hTotal ?? 0}</p>
              </div>
              <div className="rounded-xl border border-border bg-black/20 px-3 py-2">
                <p className="text-[9px] uppercase tracking-wider text-zinc-600">Missing storage ref</p>
                <p className={`mt-0.5 font-mono text-lg font-black ${(s?.missingStorageRefCount ?? 0) > 0 ? 'text-red-400' : 'text-green-400'}`}>
                  {s?.missingStorageRefCount ?? 0}
                </p>
              </div>
            </div>
            {(s?.missingStorageRefCount ?? 0) > 0 && (
              <p className="text-[11px] text-red-400 font-bold">
                ⚠ {s!.missingStorageRefCount} selfie row(s) in the last 24h lack a valid Supabase storage
                reference. These may be legacy inline base64 rows. Telegram cannot deliver photos for these.
              </p>
            )}
            {(s?.recentLogs?.length ?? 0) > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="border-b border-border text-zinc-600 text-left">
                      <th className="pb-1 pr-3">Employee</th>
                      <th className="pb-1 pr-3">Storage</th>
                      <th className="pb-1 pr-3">Size</th>
                      <th className="pb-1 pr-3">Captured</th>
                      <th className="pb-1">Reviewed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(s?.recentLogs ?? []).map(row => (
                      <tr key={row.id} className="border-b border-border/50">
                        <td className="py-1 pr-3 font-mono text-cream">{row.employeeId}</td>
                        <td className="py-1 pr-3"><StorageTypeBadge type={row.storageType} /></td>
                        <td className="py-1 pr-3 font-mono text-zinc-400">{(row.sizeBytes / 1024).toFixed(0)}KB</td>
                        <td className="py-1 pr-3 text-zinc-400">{new Date(row.capturedAt).toLocaleString()}</td>
                        <td className="py-1 text-zinc-500">{row.reviewedAt ? '✓' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>

      {/* Recent Telegram delivery logs */}
      <Card className="p-5 space-y-3">
        <p className="text-[11px] font-black uppercase tracking-widest text-zinc-500">Recent Telegram delivery log</p>
        {loading ? (
          <Skeleton className="h-40" />
        ) : !(data?.recentTelegramLogs?.length) ? (
          <p className="text-[11px] text-zinc-500">No Telegram queue rows found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="border-b border-border text-zinc-600 text-left">
                  <th className="pb-1 pr-3">Event</th>
                  <th className="pb-1 pr-3">Status</th>
                  <th className="pb-1 pr-3">Attempts</th>
                  <th className="pb-1 pr-3">Age</th>
                  <th className="pb-1 pr-3">Error</th>
                  <th className="pb-1">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data!.recentTelegramLogs.map(row => (
                  <tr key={row.id} className="border-b border-border/40">
                    <td className="py-1 pr-3 font-mono text-[9px] text-cream max-w-[140px] truncate">{row.eventType.replace('ATTENDANCE_', '')}</td>
                    <td className="py-1 pr-3"><StatusBadge status={row.status} /></td>
                    <td className="py-1 pr-3 font-mono text-zinc-400">{row.attempts}/{row.maxAttempts}</td>
                    <td className="py-1 pr-3 text-zinc-500">{row.ageMinutes}m</td>
                    <td className="py-1 pr-3 text-red-400 max-w-[160px] truncate" title={row.errorMessage ?? ''}>{row.errorMessage ?? '—'}</td>
                    <td className="py-1">
                      {(row.status === 'FAILED' || row.status === 'QUEUED') && (
                        <button
                          className="text-[9px] text-gold-lt hover:underline disabled:opacity-40"
                          disabled={actionBusy}
                          onClick={() => void runAction('retry_single', 'Retry', { id: row.id })}
                        >
                          Retry
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <p className="text-[9px] text-zinc-600">
            Generated {new Date(data.generatedAt).toLocaleString()} · Read-only diagnostics
          </p>
        )}
      </Card>
    </div>
  )
}
