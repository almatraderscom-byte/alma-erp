'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Button, Card, Empty, KpiCard, Skeleton, Spinner } from '@/components/ui'
import { EmployeeAvatar } from '@/components/profile/EmployeeAvatar'
import { useRegisterMobileRefresh } from '@/hooks/useRegisterMobileRefresh'
import type { ApprovalAuditEntry } from '@/lib/approval-types'

type ApprovalRow = {
  id: string
  module: string
  type: string
  businessId?: string | null
  entityId: string
  requestedBy: string
  approvedBy?: string | null
  rejectedBy?: string | null
  reason: string
  payloadSnapshot?: unknown
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED'
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL'
  actionUrl?: string | null
  auditHistory?: unknown
  createdAt: string
  approvedAt?: string | null
  rejectedAt?: string | null
  requester?: { id: string; name: string; email?: string | null; role: string; profileImageUrl?: string | null } | null
  businessName?: string
  entityLabel?: string
  executable?: boolean
  linkageStatus?: string
  sourceStatus?: string | null
}

type ApprovalResponse = {
  approvals: ApprovalRow[]
  totalPending: number
  byModule: Array<{ module: string; count: number }>
  byPriority: Array<{ priority: string; count: number }>
}

type IntegrityReport = {
  scanned: number
  pendingWaivers?: number
  walletOrphans?: Array<{ approvalId: string; kind: string }>
  penaltyApprovalOrphans?: Array<{ approvalId: string; kind: string }>
  penaltyWaiverOrphans?: Array<{ waiverId: string; kind: string; employeeId?: string }>
  orphans: Array<{ approvalId?: string; waiverId?: string; kind: string }>
}

export default function ApprovalsPage() {
  const [data, setData] = useState<ApprovalResponse | null>(null)
  const [status, setStatus] = useState<'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'>('PENDING')
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<ApprovalRow | null>(null)
  const [actionTarget, setActionTarget] = useState<{ row: ApprovalRow; action: 'APPROVE' | 'REJECT' } | null>(null)
  const [note, setNote] = useState('')
  const [processingId, setProcessingId] = useState<string | null>(null)
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null)
  const [integrityLoading, setIntegrityLoading] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [showIntegrity, setShowIntegrity] = useState(false)

  const load = useCallback(async (silent = false) => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    if (!silent) setLoading(true)
    try {
      const res = await fetch(`/api/approvals?status=${status}&limit=80`, { cache: 'no-store' })
      const json = await res.json()
      if (res.ok) setData(json)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [status])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const onUpdated = () => { void load(true) }
    window.addEventListener('alma:approvals-updated', onUpdated)
    return () => window.removeEventListener('alma:approvals-updated', onUpdated)
  }, [load])
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(true)
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [load])
  useRegisterMobileRefresh(() => load(true))

  const loadIntegrity = useCallback(async () => {
    setIntegrityLoading(true)
    try {
      const res = await fetch('/api/approvals/integrity', { cache: 'no-store' })
      const json = await res.json()
      if (res.ok) setIntegrity(json)
      else toast.error(json.error || 'Integrity scan failed')
    } finally {
      setIntegrityLoading(false)
    }
  }, [])

  async function repairIntegrity() {
    setRepairing(true)
    try {
      const res = await fetch('/api/approvals/integrity', { method: 'POST', cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Repair failed')
      toast.success(`Repaired ${(json.repaired || []).length} item(s)`)
      await loadIntegrity()
      await load(true)
      window.dispatchEvent(new Event('alma:approvals-updated'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRepairing(false)
    }
  }

  const priorityCounts = useMemo(() => Object.fromEntries((data?.byPriority || []).map(row => [row.priority, row.count])), [data])
  const orphanCount = integrity?.orphans?.length ?? 0

  async function processApproval(row: ApprovalRow, action: 'APPROVE' | 'REJECT', actionNote = '') {
    if (action === 'REJECT' && actionNote.trim().length < 5) {
      toast.error('Rejection reason must be at least 5 characters')
      return
    }
    setProcessingId(row.id)
    const previous = data
    if (row.status === 'PENDING') {
      setData(current => current ? {
        ...current,
        approvals: current.approvals.filter(item => item.id !== row.id),
        totalPending: Math.max(0, current.totalPending - 1),
      } : current)
      window.dispatchEvent(new Event('alma:approvals-updated'))
    }
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, note: actionNote }),
        cache: 'no-store',
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) throw new Error(json.error || 'Approval action failed')
      if (json.reconciled) {
        toast.success(action === 'REJECT' ? 'Approval synced (already handled in Payroll)' : 'Approval synced with existing payroll decision')
      } else {
        toast.success(action === 'APPROVE' ? 'Approval processed' : 'Request rejected')
      }
      setSelected(null)
      setActionTarget(null)
      setNote('')
      await load(true)
      window.dispatchEvent(new Event('alma:approvals-updated'))
    } catch (e) {
      setData(previous)
      toast.error((e as Error).message)
    } finally {
      setProcessingId(null)
    }
  }

  return (
    <main className="space-y-5 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-gold">Global Control</p>
          <h1 className="mt-1 text-2xl font-black text-cream">Approvals</h1>
          <p className="mt-1 text-sm text-zinc-500">Persistent authorization requests. Reading notifications never clears this queue.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={showIntegrity ? 'gold' : 'ghost'}
            onClick={() => {
              setShowIntegrity(v => !v)
              if (!integrity && !showIntegrity) void loadIntegrity()
            }}
          >
            Integrity
          </Button>
          {(['PENDING', 'APPROVED', 'REJECTED', 'ALL'] as const).map(value => (
            <Button key={value} variant={status === value ? 'gold' : 'ghost'} onClick={() => setStatus(value)}>
              {value === 'ALL' ? 'All' : value.charAt(0) + value.slice(1).toLowerCase()}
            </Button>
          ))}
        </div>
      </div>

      {showIntegrity && (
        <Card className="border-amber-500/20 bg-amber-500/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-black text-cream">Integrity Monitor</p>
              <p className="mt-1 text-xs text-zinc-500">
                Detects orphan approvals, hidden penalty appeals, and stale pending rows.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" disabled={integrityLoading} onClick={() => void loadIntegrity()}>
                {integrityLoading ? <Spinner /> : 'Scan'}
              </Button>
              <Button size="sm" variant="gold" disabled={repairing || !orphanCount} onClick={() => void repairIntegrity()}>
                {repairing ? <Spinner /> : `Repair (${orphanCount})`}
              </Button>
            </div>
          </div>
          {integrity && (
            <div className="mt-4 grid gap-2 text-xs md:grid-cols-4">
              <IntegrityStat label="Pending scanned" value={integrity.scanned} />
              <IntegrityStat label="Pending waivers" value={integrity.pendingWaivers ?? 0} />
              <IntegrityStat label="Wallet orphans" value={integrity.walletOrphans?.length ?? 0} warn />
              <IntegrityStat
                label="Penalty orphans"
                value={(integrity.penaltyApprovalOrphans?.length ?? 0) + (integrity.penaltyWaiverOrphans?.length ?? 0)}
                warn
              />
            </div>
          )}
          {integrity?.orphans?.length ? (
            <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto text-[11px] text-zinc-400">
              {integrity.orphans.slice(0, 12).map((row, i) => (
                <li key={`${row.kind}-${row.approvalId || row.waiverId || i}`}>
                  {row.kind.replace(/_/g, ' ')}
                  {row.approvalId ? ` · approval ${row.approvalId.slice(0, 8)}…` : ''}
                  {row.waiverId ? ` · waiver ${row.waiverId.slice(0, 8)}…` : ''}
                </li>
              ))}
            </ul>
          ) : integrity && !integrityLoading ? (
            <p className="mt-3 text-[11px] font-bold text-green-300">No linkage issues detected in scan window.</p>
          ) : null}
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard label="Pending" value={data?.totalPending ?? 0} loading={loading} color="text-gold-lt" />
        <KpiCard label="Critical" value={priorityCounts.CRITICAL ?? 0} loading={loading} color="text-red-300" />
        <KpiCard label="High" value={priorityCounts.HIGH ?? 0} loading={loading} color="text-amber-300" />
        <KpiCard label="Normal" value={priorityCounts.NORMAL ?? 0} loading={loading} />
        <KpiCard label="Low" value={priorityCounts.LOW ?? 0} loading={loading} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[0.8fr_1.5fr]">
        <Card className="p-4">
          <p className="text-sm font-black text-cream">Pending by module</p>
          <div className="mt-4 space-y-2">
            {loading && !data ? <Skeleton className="h-32" /> : !(data?.byModule.length) ? <Empty icon="◆" title="No pending modules" /> : data.byModule.map(row => (
              <div key={row.module} className="flex items-center justify-between rounded-2xl border border-border bg-black/20 px-3 py-2 text-sm">
                <span className="font-bold text-zinc-300">{row.module.replace(/_/g, ' ')}</span>
                <span className="rounded-full bg-gold/10 px-2 py-1 text-xs font-black text-gold-lt">{row.count}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="overflow-hidden">
          {loading && !data ? <Skeleton className="h-96" /> : !(data?.approvals.length) ? <Empty icon="◆" title="No approval requests" /> : (
            <div className="divide-y divide-border">
              {data.approvals.map(row => (
                <div key={row.id} className="grid gap-3 px-4 py-3 text-xs md:grid-cols-[1fr_0.8fr_1.2fr_0.9fr_1.1fr]">
                  <div>
                    <p className="font-black text-cream">{row.type.replace(/_/g, ' ')}</p>
                    <p className="mt-1 text-zinc-500">{row.module.replace(/_/g, ' ')} · {row.businessName || row.businessId || 'Global'}</p>
                    <p className="mt-1 text-zinc-600">{new Date(row.createdAt).toLocaleString()}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <EmployeeAvatar
                      userId={row.requester?.id}
                      name={row.requester?.name || row.requestedBy}
                      imageUrl={row.requester?.profileImageUrl}
                      size="sm"
                    />
                    <div>
                      <p className="font-bold text-zinc-300">{row.requester?.name || row.requestedBy}</p>
                      <p className="mt-1 text-zinc-500">{row.requester?.role?.replace(/_/g, ' ') || 'Requester'}</p>
                    </div>
                  </div>
                  <div>
                    <p className="font-bold text-zinc-300">{row.entityLabel || row.entityId}</p>
                    <p className="mt-1 line-clamp-2 text-zinc-500">{row.reason}</p>
                  </div>
                  <div>
                    <p className={`font-black ${row.priority === 'CRITICAL' ? 'text-red-300' : row.priority === 'HIGH' ? 'text-amber-300' : 'text-zinc-300'}`}>{row.priority}</p>
                    <p className={row.status === 'PENDING' ? 'mt-1 font-black text-gold-lt' : row.status === 'APPROVED' ? 'mt-1 font-black text-green-300' : 'mt-1 font-black text-red-300'}>{row.status}</p>
                    {row.linkageStatus === 'orphan_source_already_resolved' && (
                      <p className="mt-1 text-[10px] font-bold text-amber-300">
                        Payroll already {row.sourceStatus || 'resolved'} — reject will sync queue
                      </p>
                    )}
                    {row.linkageStatus === 'orphan_missing_source' && (
                      <p className="mt-1 text-[10px] font-bold text-red-300">Source record missing</p>
                    )}
                    {row.linkageStatus === 'orphan_missing_approval' && (
                      <p className="mt-1 text-[10px] font-bold text-red-300">Central approval missing — run Integrity repair</p>
                    )}
                    {lastAuditSource(row.auditHistory) && (
                      <p className="mt-1 text-[10px] font-bold uppercase tracking-wide text-zinc-500">
                        via {lastAuditSource(row.auditHistory)}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="xs" variant="ghost" onClick={() => setSelected(row)}>View Details</Button>
                    {row.status === 'PENDING' && row.executable && (
                      <Button size="xs" variant="gold" disabled={processingId === row.id} onClick={() => void processApproval(row, 'APPROVE')}>
                        {processingId === row.id ? <Spinner /> : 'Approve'}
                      </Button>
                    )}
                    {row.status === 'PENDING' && (
                      <Button size="xs" variant="danger" disabled={processingId === row.id} onClick={() => { setActionTarget({ row, action: 'REJECT' }); setNote('') }}>
                        Reject
                      </Button>
                    )}
                    {row.status === 'PENDING' && !row.executable && <span className="text-[10px] font-bold text-amber-300">Manual review</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {selected && (
        <div className="fixed inset-0 z-[10000] flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-4">
          <Card className="max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-y-auto p-5">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-black text-cream">{selected.type.replace(/_/g, ' ')}</p>
                <p className="mt-1 text-xs text-zinc-500">{selected.module} · {new Date(selected.createdAt).toLocaleString()}</p>
              </div>
              <Button size="xs" variant="ghost" onClick={() => setSelected(null)}>Close</Button>
            </div>
            <div className="flex items-center gap-3 rounded-2xl border border-border bg-black/20 p-3">
              <EmployeeAvatar
                userId={selected.requester?.id}
                name={selected.requester?.name || selected.requestedBy}
                imageUrl={selected.requester?.profileImageUrl}
                size="lg"
              />
              <div>
                <p className="text-sm font-bold text-cream">{selected.requester?.name || selected.requestedBy}</p>
                <p className="text-[11px] text-zinc-500">{selected.requester?.role?.replace(/_/g, ' ') || 'Requester'}</p>
              </div>
            </div>
            <div className="space-y-3 text-xs">
              <Info label="Status" value={selected.status} />
              <Info label="Priority" value={selected.priority} />
              <Info label="Business" value={selected.businessName || selected.businessId || 'Global'} />
              <Info label="Entity / account affected" value={selected.entityLabel || selected.entityId} />
              <Info label="Reason" value={selected.reason} />
              <div className="flex flex-wrap gap-2">
                {selected.status === 'PENDING' && selected.executable && <Button variant="gold" disabled={processingId === selected.id} onClick={() => void processApproval(selected, 'APPROVE')}>{processingId === selected.id ? <><Spinner /> Processing</> : 'Approve'}</Button>}
                {selected.status === 'PENDING' && <Button variant="danger" disabled={processingId === selected.id} onClick={() => { setActionTarget({ row: selected, action: 'REJECT' }); setNote('') }}>Reject</Button>}
                {selected.actionUrl && <a href={selected.actionUrl} className="inline-flex rounded-xl border border-gold-dim/40 px-3 py-2 font-bold text-gold-lt">Open related record</a>}
              </div>
              <pre className="max-h-64 overflow-auto rounded-2xl border border-border bg-black/30 p-3 text-[11px] text-zinc-300">{JSON.stringify({ payloadSnapshot: selected.payloadSnapshot, auditHistory: selected.auditHistory }, null, 2)}</pre>
            </div>
          </Card>
        </div>
      )}
      {actionTarget && (
        <div className="fixed inset-0 z-[10001] flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-4">
          <Card className="w-full max-w-lg p-5">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-black text-cream">Reject Approval</p>
                <p className="mt-1 text-xs text-zinc-500">{actionTarget.row.type.replace(/_/g, ' ')} · {actionTarget.row.requester?.name || actionTarget.row.requestedBy}</p>
              </div>
              <Button size="xs" variant="ghost" onClick={() => setActionTarget(null)}>Close</Button>
            </div>
            <textarea value={note} onChange={e => setNote(e.target.value)} className="min-h-28 w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-cream outline-none focus:border-gold-dim/60" placeholder="Rejection reason required" />
            <Button variant="danger" className="mt-3 w-full justify-center" disabled={processingId === actionTarget.row.id} onClick={() => void processApproval(actionTarget.row, 'REJECT', note)}>
              {processingId === actionTarget.row.id ? <><Spinner /> Rejecting</> : 'Reject request'}
            </Button>
          </Card>
        </div>
      )}
    </main>
  )
}

function lastAuditSource(auditHistory: unknown): string | null {
  if (!Array.isArray(auditHistory) || !auditHistory.length) return null
  const resolved = [...auditHistory].reverse().find(entry => {
    const row = entry as ApprovalAuditEntry
    return row?.action === 'APPROVED' || row?.action === 'REJECTED'
  }) as ApprovalAuditEntry | undefined
  const source = resolved?.source
  if (source === 'telegram') return 'Telegram'
  if (source === 'attendance') return 'Attendance'
  if (source === 'erp') return 'ERP'
  return source || null
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="rounded-2xl border border-border bg-black/20 p-3"><p className="text-[10px] font-black uppercase tracking-[0.14em] text-zinc-600">{label}</p><p className="mt-1 font-bold text-cream">{value}</p></div>
}

function IntegrityStat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-black/20 px-3 py-2">
      <p className="text-[10px] font-black uppercase tracking-wide text-zinc-600">{label}</p>
      <p className={`mt-1 text-lg font-black ${warn && value > 0 ? 'text-amber-300' : 'text-cream'}`}>{value}</p>
    </div>
  )
}
