'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { Button, Card, PageHeader, Skeleton } from '@/components/ui'
import { useBusiness } from '@/contexts/BusinessContext'
import { safeFetchJson } from '@/lib/safe-fetch'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } }
const fadeUp = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.25 } } }

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
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-red-200 bg-red-50 text-red-700'
      }`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
      {label}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    QUEUED: 'border-amber-200 bg-amber-50 text-amber-700',
    SENDING: 'border-blue-200 bg-blue-50 text-blue-700',
    SENT: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    FAILED: 'border-red-200 bg-red-50 text-red-700',
    SKIPPED: 'border-border bg-white/[0.04] text-muted-hi',
  }
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-bold uppercase border ${map[status] ?? 'text-muted border-border bg-white/[0.04]'}`}>
      {status}
    </span>
  )
}

function StorageTypeBadge({ type }: { type: string }) {
  if (type === 'supabase') return <span className="text-emerald-600 font-bold">supabase ✓</span>
  if (type === 'inline_base64') return <span className="text-amber-600 font-bold">inline_base64 ⚠</span>
  return <span className="text-red-600 font-bold">unknown ✗</span>
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
    <div className="min-h-screen bg-transparent">
      <PageHeader
        title="System Diagnostics"
        subtitle="Read-only observability for Telegram queue and photo storage health. SUPER_ADMIN only."
        actions={
          <Button size="xs" variant="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
        }
      />

      <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-5 px-3 py-4 pb-24 sm:px-6 md:pb-6">
        <motion.div variants={fadeUp}>
          <Card className="rounded-2xl border border-white/[0.06] p-5 space-y-3 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted">System config</p>
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
              <p className="text-[11px] text-red-600 font-semibold">
                ⚠ CRON_SECRET is not set — Vercel cron job will return 500 and no Telegram rows will be
                processed automatically. Set CRON_SECRET in Vercel environment variables.
              </p>
            )}
            {data && !data.config.botTokenConfigured && (
              <p className="text-[11px] text-red-600 font-semibold">
                ⚠ TELEGRAM_BOT_TOKEN is missing — all deliveries will fail immediately.
              </p>
            )}
            {data && !data.config.ownerChatIdsConfigured && (
              <p className="text-[11px] text-red-600 font-semibold">
                ⚠ No owner Telegram chat IDs (DB or TELEGRAM_OWNER_CHAT_IDS env) — check-in alerts are
                skipped at enqueue. Configure IDs in Settings → Telegram Ops.
              </p>
            )}
            {data?.config.ownerRoutingSource === 'disabled' && (
              <p className="text-[11px] text-amber-600 font-semibold">
                ⚠ Telegram ops is disabled for this business — notifications will not enqueue.
              </p>
            )}
          </Card>
        </motion.div>

        <motion.div variants={fadeUp}>
          <Card className="rounded-2xl border border-white/[0.06] p-5 space-y-4 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted">Telegram queue</p>
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
                    <div key={s.status} className="rounded-xl border border-white/[0.06] bg-card/85 px-4 py-3">
                      <p className="text-[9px] uppercase tracking-wider text-muted font-semibold">{s.status}</p>
                      <p className="mt-0.5 font-mono text-lg font-bold text-cream">{s.count}</p>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-[11px]">
                  <div className="rounded-xl border border-white/[0.06] bg-card/85 px-4 py-3">
                    <p className="text-muted">Pending depth</p>
                    <p className={`font-mono font-bold ${(q?.pendingDepth ?? 0) > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{q?.pendingDepth ?? 0}</p>
                  </div>
                  <div className="rounded-xl border border-white/[0.06] bg-card/85 px-4 py-3">
                    <p className="text-muted">Stuck sending</p>
                    <p className={`font-mono font-bold ${(q?.stuckSending ?? 0) > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{q?.stuckSending ?? 0}</p>
                  </div>
                  <div className="rounded-xl border border-white/[0.06] bg-card/85 px-4 py-3">
                    <p className="text-muted">Retry wait</p>
                    <p className="font-mono font-bold text-cream">{q?.retryWaitCount ?? 0}</p>
                  </div>
                  <div className="rounded-xl border border-white/[0.06] bg-card/85 px-4 py-3">
                    <p className="text-muted">Dead letter (max attempts)</p>
                    <p className={`font-mono font-bold ${(q?.failedDeadLetter ?? 0) > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                      {q?.failedDeadLetter ?? 0}
                      {q?.maxAttempts != null ? ` / ${q.maxAttempts}` : ''}
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/[0.06] bg-card/85 px-4 py-3">
                    <p className="text-muted">Avg delivery latency</p>
                    <p className="font-mono font-bold text-cream">
                      {q?.averageDeliveryLatencyMs != null ? `${q.averageDeliveryLatencyMs}ms` : 'N/A'}
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/[0.06] bg-card/85 px-4 py-3 col-span-2 sm:col-span-1">
                    <p className="text-muted">Oldest pending</p>
                    {q?.oldestQueued ? (
                      <p className="font-mono font-bold text-amber-600">
                        {q.oldestQueued.eventType} · {q.oldestQueued.ageMinutes}min ago
                      </p>
                    ) : (
                      <p className="font-mono font-bold text-emerald-600">None</p>
                    )}
                  </div>
                </div>
              </>
            )}
          </Card>
        </motion.div>

        <motion.div variants={fadeUp}>
          <Card className="rounded-2xl border border-white/[0.06] p-5 space-y-4 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted">Selfie photo storage (last 24h)</p>
            {loading ? (
              <Skeleton className="h-16" />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-white/[0.06] bg-card/85 px-4 py-3">
                    <p className="text-[9px] uppercase tracking-wider text-muted font-semibold">Total selfies</p>
                    <p className="mt-0.5 font-mono text-lg font-bold text-cream">{s?.last24hTotal ?? 0}</p>
                  </div>
                  <div className="rounded-xl border border-white/[0.06] bg-card/85 px-4 py-3">
                    <p className="text-[9px] uppercase tracking-wider text-muted font-semibold">Missing storage ref</p>
                    <p className={`mt-0.5 font-mono text-lg font-bold ${(s?.missingStorageRefCount ?? 0) > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                      {s?.missingStorageRefCount ?? 0}
                    </p>
                  </div>
                </div>
                {(s?.missingStorageRefCount ?? 0) > 0 && (
                  <p className="text-[11px] text-red-600 font-semibold">
                    ⚠ {s!.missingStorageRefCount} selfie row(s) in the last 24h lack a valid Supabase storage
                    reference. These may be legacy inline base64 rows. Telegram cannot deliver photos for these.
                  </p>
                )}
                {(s?.recentLogs?.length ?? 0) > 0 && (
                  <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
                    <table className="w-full text-[10px]">
                      <thead>
                        <tr className="border-b border-white/[0.06] bg-white/[0.04] text-muted text-left">
                          <th className="py-2 px-3 font-semibold">Employee</th>
                          <th className="py-2 px-3 font-semibold">Storage</th>
                          <th className="py-2 px-3 font-semibold">Size</th>
                          <th className="py-2 px-3 font-semibold">Captured</th>
                          <th className="py-2 px-3 font-semibold">Reviewed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(s?.recentLogs ?? []).map(row => (
                          <tr key={row.id} className="border-b border-white/[0.04] hover:bg-white/[0.04] transition-colors">
                            <td className="py-2 px-3 font-mono text-cream">{row.employeeId}</td>
                            <td className="py-2 px-3"><StorageTypeBadge type={row.storageType} /></td>
                            <td className="py-2 px-3 font-mono text-muted-hi">{(row.sizeBytes / 1024).toFixed(0)}KB</td>
                            <td className="py-2 px-3 text-muted">{new Date(row.capturedAt).toLocaleString()}</td>
                            <td className="py-2 px-3 text-muted">{row.reviewedAt ? '✓' : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </Card>
        </motion.div>

        <motion.div variants={fadeUp}>
          <Card className="rounded-2xl border border-white/[0.06] p-5 space-y-3 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted">Recent Telegram delivery log</p>
            {loading ? (
              <Skeleton className="h-40" />
            ) : !(data?.recentTelegramLogs?.length) ? (
              <p className="text-[11px] text-muted">No Telegram queue rows found.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="border-b border-white/[0.06] bg-white/[0.04] text-muted text-left">
                      <th className="py-2 px-3 font-semibold">Event</th>
                      <th className="py-2 px-3 font-semibold">Status</th>
                      <th className="py-2 px-3 font-semibold">Attempts</th>
                      <th className="py-2 px-3 font-semibold">Age</th>
                      <th className="py-2 px-3 font-semibold">Error</th>
                      <th className="py-2 px-3 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.recentTelegramLogs.map(row => (
                      <tr key={row.id} className="border-b border-white/[0.04] hover:bg-white/[0.04] transition-colors">
                        <td className="py-2 px-3 font-mono text-[9px] text-cream max-w-[140px] truncate">{row.eventType.replace('ATTENDANCE_', '')}</td>
                        <td className="py-2 px-3"><StatusBadge status={row.status} /></td>
                        <td className="py-2 px-3 font-mono text-muted-hi">{row.attempts}/{row.maxAttempts}</td>
                        <td className="py-2 px-3 text-muted">{row.ageMinutes}m</td>
                        <td className="py-2 px-3 text-red-600 max-w-[160px] truncate" title={row.errorMessage ?? ''}>{row.errorMessage ?? '—'}</td>
                        <td className="py-2 px-3">
                          {(row.status === 'FAILED' || row.status === 'QUEUED') && (
                            <button
                              className="text-[9px] font-semibold text-[#E07A5F] hover:underline disabled:opacity-40"
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
              <p className="text-[9px] text-muted">
                Generated {new Date(data.generatedAt).toLocaleString()} · Read-only diagnostics
              </p>
            )}
          </Card>
        </motion.div>
      </motion.div>
    </div>
  )
}
