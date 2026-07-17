'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { ApprovalProcessingBanner, ApprovalRowProcessingBadge, approvalRowLockClass } from '@/components/approvals/ApprovalActionStatus'
import { PayoutSummaryBlock } from '@/components/approvals/PayoutSummaryBlock'
import { SalaryCorrectionCard } from '@/components/approvals/SalaryCorrectionCard'
import { Button, Card, Empty, KpiCard, PageHeader, Skeleton, Spinner } from '@/components/ui'
import { EmployeeAvatar } from '@/components/profile/EmployeeAvatar'
import { useApprovalActions } from '@/hooks/useApprovalActions'
import { safeFetchJsonWithToast } from '@/lib/safe-fetch'
import {
  BKASH_APP_URL,
  clearBkashSendPending,
  copyTextToClipboard,
  extractTrxIdFromText,
  readBkashSendPending,
  readClipboardText,
  saveBkashSendPending,
} from '@/lib/bkash-send-flow'
import { useRegisterMobileRefresh } from '@/hooks/useRegisterMobileRefresh'
import type { ApprovalAuditEntry } from '@/lib/approval-types'
import { normalizeApprovalResponse } from '@/lib/approvals-response'
import { SectionErrorBoundary } from '@/components/runtime/SectionErrorBoundary'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import AgentApprovalsTab from '@/components/approvals/AgentApprovalsTab'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } }
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.35 } } }

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
  requester?: { id: string; name: string; email?: string | null; role: string; profileImageUrl?: string | null; employeeIdGas?: string | null } | null
  businessName?: string
  entityLabel?: string
  executable?: boolean
  linkageStatus?: string
  sourceStatus?: string | null
  payoutSummary?: {
    label?: string
    accountHolder?: string | null
    accountNumber?: string
    accountNumberMasked?: string
    isVerified?: boolean
    status?: string
    provider?: string | null
  } | null
  penaltyAppeal?: {
    fineDate?: string
    fineKind?: 'LATE' | 'EARLY_LEAVE' | 'NO_CHECKOUT' | 'UNKNOWN'
    lateMinutes?: number | null
    earlyLeaveMinutes?: number | null
    checkInAt?: string | null
    checkOutAt?: string | null
    originalPenaltyAmount?: number
    requestedReductionAmount?: number | null
    requestType?: string
    appealSubmittedAt?: string
  } | null
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
  return (
    <SectionErrorBoundary section="approvals" title="Approvals unavailable">
      <ApprovalsPageInner />
    </SectionErrorBoundary>
  )
}

function ApprovalsPageInner() {
  const [data, setData] = useState<ApprovalResponse | null>(null)
  const [view, setView] = useState<'business' | 'agent'>('business')
  const [status, setStatus] = useState<'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'>('PENDING')
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<ApprovalRow | null>(null)
  const [actionTarget, setActionTarget] = useState<{ row: ApprovalRow; action: 'APPROVE' | 'REJECT' } | null>(null)
  const [withdrawApprove, setWithdrawApprove] = useState<{ row: ApprovalRow; transactionId: string; resumedFromBkash?: boolean } | null>(null)
  // Reimbursement approvals pause for a payout choice: wallet credit vs already-paid-instantly.
  const [reimburseApprove, setReimburseApprove] = useState<ApprovalRow | null>(null)
  const [note, setNote] = useState('')
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null)
  const [integrityLoading, setIntegrityLoading] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [showIntegrity, setShowIntegrity] = useState(false)

  const load = useCallback(async (silent = false) => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    if (!silent) setLoading(true)
    try {
      const result = await safeFetchJsonWithToast<ApprovalResponse>(
        `/api/approvals?status=${status}&limit=80`,
        { cache: 'no-store', toastOnError: false },
      )
      if (result.ok) {
        setData(normalizeApprovalResponse(result.data) as ApprovalResponse)
      } else if (!silent) {
        toast.error(result.error.message || 'Could not load approvals')
      }
    } catch (e) {
      toast.error((e as Error).message || 'Network error loading approvals')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [status])

  const refreshApprovals = useCallback(async () => { await load(true) }, [load])
  const { hasProcessing, processingOps, executeApproval, isRowProcessing, getRowUi } = useApprovalActions(refreshApprovals)

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const onUpdated = () => { void load(true) }
    window.addEventListener('alma:approvals-updated', onUpdated)
    return () => window.removeEventListener('alma:approvals-updated', onUpdated)
  }, [load])
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden && !hasProcessing) void load(true)
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [hasProcessing, load])
  useRegisterMobileRefresh(() => load(true))

  const loadIntegrity = useCallback(async () => {
    setIntegrityLoading(true)
    try {
      const result = await safeFetchJsonWithToast<IntegrityReport>('/api/approvals/integrity', {
        cache: 'no-store',
        toastOnError: false,
      })
      if (result.ok) setIntegrity(result.data)
      else toast.error(result.error.message || 'Integrity scan failed')
    } catch (e) {
      toast.error((e as Error).message || 'Integrity scan unavailable')
    } finally {
      setIntegrityLoading(false)
    }
  }, [])

  async function repairIntegrity() {
    setRepairing(true)
    try {
      const result = await safeFetchJsonWithToast<{ repaired?: unknown[] }>('/api/approvals/integrity', {
        method: 'POST',
        cache: 'no-store',
      })
      if (!result.ok) throw new Error(result.error.message)
      const repaired = result.data.repaired || []
      toast.success(`Repaired ${repaired.length} item(s)`)
      await loadIntegrity()
      await load(true)
      window.dispatchEvent(new Event('alma:approvals-updated'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRepairing(false)
    }
  }

  const approvals = data?.approvals ?? []
  const byModule = data?.byModule ?? []
  const priorityCounts = useMemo(() => Object.fromEntries((data?.byPriority || []).map(row => [row.priority, row.count])), [data])
  const orphanCount = integrity?.orphans?.length ?? 0

  async function processApproval(row: ApprovalRow, action: 'APPROVE' | 'REJECT', actionNote = '', transactionId?: string, payoutMode?: 'wallet' | 'instant') {
    if (isRowProcessing(row.id)) return
    if (action === 'REJECT' && actionNote.trim().length < 5) {
      toast.error('Rejection reason must be at least 5 characters')
      return
    }
    const result = await executeApproval({
      approvalId: row.id,
      action,
      note: actionNote,
      rowLabel: row.type.replace(/_/g, ' '),
      transactionId,
      payoutMode,
    })
    if (result.ok) {
      const pending = readBkashSendPending()
      if (pending?.surface === 'approvals' && pending.requestId === row.id) clearBkashSendPending()
      setSelected(current => (current?.id === row.id ? null : current))
      setActionTarget(null)
      setWithdrawApprove(null)
      setReimburseApprove(null)
      setNote('')
    }
  }

  /** Owner-only bKash send flow: the API reveals the full payout number only to
   *  SUPER_ADMIN; masked (starred) or absent numbers mean no send flow. */
  function bkashPayoutNumber(row: ApprovalRow): string | null {
    const p = row.payoutSummary
    if (!p || p.provider !== 'BKASH' || p.status === 'MISSING') return null
    const number = p.accountNumber || ''
    if (!number || number === '—' || number.includes('*')) return null
    return number
  }

  /**
   * Copy the recipient's number and remember the in-flight approval — all synchronous,
   * because the caller is an <a href={BKASH_APP_URL}> whose default navigation opens
   * the bKash app. iOS only honours that Universal Link while the gesture flag is
   * live, so nothing here may await (the original bug) and we must not preventDefault.
   */
  function startBkashSend() {
    if (!withdrawApprove) return
    const number = bkashPayoutNumber(withdrawApprove.row)
    if (!number) return
    const copied = copyTextToClipboard(number)
    saveBkashSendPending({
      surface: 'approvals',
      requestId: withdrawApprove.row.id,
      employeeId: withdrawApprove.row.requester?.employeeIdGas || '',
      businessId: withdrawApprove.row.businessId || '',
      requestedAmount: 0,
      approvedAmount: 0,
      recipientNumber: number,
      recipientName: withdrawApprove.row.payoutSummary?.accountHolder ?? withdrawApprove.row.requester?.name ?? null,
      startedAt: Date.now(),
    })
    toast.success(copied
      ? 'নম্বর কপি হয়েছে — বিকাশে Send Money-তে পেস্ট করুন'
      : `কপি হয়নি — নম্বরটি নিজে লিখুন: ${number}`)
  }

  /** Fill the Transaction ID field from the clipboard (bKash success screen → copy → return). */
  async function pasteTrxId() {
    const raw = ((await readClipboardText()) || '').trim()
    const extracted = extractTrxIdFromText(raw)
    // Never accept a pure number — that's the recipient's phone number we copied
    // on the way out, or an amount.
    const fallback = /^[A-Za-z0-9-]{6,30}$/.test(raw) && !/^\d+$/.test(raw) ? raw : ''
    const trx = extracted || fallback
    if (!trx) {
      toast.error('ক্লিপবোর্ডে TrxID পাওয়া যায়নি — বিকাশের সফল স্ক্রিন থেকে TrxID কপি করুন')
      return
    }
    setWithdrawApprove(w => (w ? { ...w, transactionId: trx } : w))
  }

  /** Close the withdraw modal; a half-done bKash confirmation is cleared so it stops re-opening. */
  function dismissWithdrawModal() {
    if (withdrawApprove) {
      const pending = readBkashSendPending()
      if (pending?.surface === 'approvals' && pending.requestId === withdrawApprove.row.id) {
        clearBkashSendPending()
        toast('বিকাশ নিশ্চিতকরণ বাতিল হলো — পরে কার্ড থেকে Approve চেপে TrxID দিতে পারবেন', { icon: 'ℹ️' })
      }
    }
    setWithdrawApprove(null)
  }

  // Coming back from the bKash app (mobile) or another tab (desktop): re-open the
  // withdraw modal for the in-flight approval so the owner can paste the TrxID.
  useEffect(() => {
    const restore = () => {
      const pending = readBkashSendPending()
      if (!pending || pending.surface !== 'approvals') return
      const row = (data?.approvals ?? []).find(r => r.id === pending.requestId && r.status === 'PENDING')
      if (row) {
        setWithdrawApprove(current => current ?? { row, transactionId: '', resumedFromBkash: true })
      } else if (data && !loading) {
        // List is genuinely loaded and the approval is gone (resolved elsewhere).
        clearBkashSendPending()
      }
    }
    restore()
    const onVisible = () => {
      if (document.visibilityState === 'visible') restore()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, loading])

  // Wallet withdrawals need a transaction id (sent to staff via SMS) — collect it first.
  function handleApproveClick(row: ApprovalRow) {
    if (row.type === 'WALLET_WITHDRAWAL') {
      setWithdrawApprove({ row, transactionId: '' })
      return
    }
    if (row.type === 'EXPENSE_REIMBURSEMENT') {
      setReimburseApprove(row)
      return
    }
    void processApproval(row, 'APPROVE')
  }

  const actionsGloballyDisabled = hasProcessing

  return (
    <main className="min-h-[100dvh] bg-transparent space-y-3 pb-24 md:space-y-5 md:pb-6">
      <PageHeader
        title="Approvals"
        subtitle="Persistent authorization requests. Reading notifications never clears this queue."
        actions={
          /* Native-iOS feel on phones: one edge-to-edge scrollable row of the SAME
             buttons (no wrapped rows eating the first screen). md:contents = desktop
             renders exactly as before, as if this wrapper didn't exist. */
          <div
            className="-mx-4 flex w-full min-w-0 flex-nowrap items-center gap-2 overflow-x-auto px-4 py-0.5 scrollbar-hide md:contents"
            style={{ WebkitOverflowScrolling: 'touch' }}
          >
            <Button
              variant={view === 'business' ? 'gold' : 'ghost'}
              onClick={() => setView('business')}
            >
              Business
            </Button>
            <Button
              variant={view === 'agent' ? 'gold' : 'ghost'}
              onClick={() => setView('agent')}
            >
              Agent
            </Button>
            {view === 'business' && (
              <>
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
                  <Button
                    key={value}
                    variant={status === value ? 'gold' : 'ghost'}
                    disabled={actionsGloballyDisabled}
                    onClick={() => setStatus(value)}
                  >
                    {value === 'ALL' ? 'All' : value.charAt(0) + value.slice(1).toLowerCase()}
                  </Button>
                ))}
              </>
            )}
          </div>
        }
      />

      {view === 'agent' && (
        <div className="min-w-0 max-w-full px-3 sm:px-6">
          <SectionErrorBoundary section="approvals-agent" title="Agent approvals unavailable">
            <AgentApprovalsTab />
          </SectionErrorBoundary>
        </div>
      )}

      {view === 'business' && (
      <motion.div variants={stagger} initial="hidden" animate="show" className="min-w-0 max-w-full space-y-3 px-3 sm:px-6 md:space-y-5">
      <ApprovalProcessingBanner
        count={processingOps.length}
        message={
          hasProcessing
            ? 'Approval still processing — stay on this page until you see committed or failed.'
            : undefined
        }
      />

      {showIntegrity && (
        <motion.div variants={fadeUp}>
        <Card className="border-amber-500/35 bg-amber-500/10 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-black text-cream">Integrity Monitor</p>
              <p className="mt-1 text-xs text-muted">
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
            <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto text-[11px] text-muted">
              {integrity.orphans.slice(0, 12).map((row, i) => (
                <li key={`${row.kind}-${row.approvalId || row.waiverId || i}`}>
                  {row.kind.replace(/_/g, ' ')}
                  {row.approvalId ? ` · approval ${row.approvalId.slice(0, 8)}…` : ''}
                  {row.waiverId ? ` · waiver ${row.waiverId.slice(0, 8)}…` : ''}
                </li>
              ))}
            </ul>
          ) : integrity && !integrityLoading ? (
            <p className="mt-3 text-[11px] font-bold text-emerald-600">No linkage issues detected in scan window.</p>
          ) : null}
        </Card>
        </motion.div>
      )}

      <motion.div variants={fadeUp}>
      {/* KPI strip — single edge-to-edge scrollable row on phones (native-iOS feel,
          same KpiCards); md+ keeps the exact 5-column grid as before. */}
      <div
        className="-mx-3 flex gap-3 overflow-x-auto px-3 py-0.5 scrollbar-hide sm:-mx-6 sm:px-6 md:mx-0 md:grid md:grid-cols-5 md:overflow-visible md:px-0 md:py-0"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        <div className="w-[9.5rem] shrink-0 md:w-auto"><KpiCard label="Pending" value={data?.totalPending ?? 0} loading={loading} color="text-gold-lt" /></div>
        <div className="w-[9.5rem] shrink-0 md:w-auto"><KpiCard label="Critical" value={priorityCounts.CRITICAL ?? 0} loading={loading} color="text-red-500" /></div>
        <div className="w-[9.5rem] shrink-0 md:w-auto"><KpiCard label="High" value={priorityCounts.HIGH ?? 0} loading={loading} color="text-amber-600" /></div>
        <div className="w-[9.5rem] shrink-0 md:w-auto"><KpiCard label="Normal" value={priorityCounts.NORMAL ?? 0} loading={loading} /></div>
        <div className="w-[9.5rem] shrink-0 md:w-auto"><KpiCard label="Low" value={priorityCounts.LOW ?? 0} loading={loading} /></div>
      </div>
      </motion.div>

      <motion.div variants={fadeUp}>
      {/* Phones: the actionable approvals list comes FIRST (native-app priority);
          the module summary follows. lg+ keeps the original side-by-side order. */}
      <div className="grid gap-4 lg:grid-cols-[0.8fr_1.5fr]">
        <Card className="order-2 p-4 lg:order-none">
          <p className="text-sm font-black text-cream">Pending by module</p>
          <div className="mt-4 space-y-2">
            {loading && !data ? <Skeleton className="h-32" /> : !byModule.length ? <Empty icon="◆" title="No pending modules" /> : byModule.map(row => (
              <div key={row.module} className="flex items-center justify-between rounded-2xl border border-border bg-white/[0.04] px-3 py-2 text-sm">
                <span className="font-bold text-cream">{row.module.replace(/_/g, ' ')}</span>
                <span className="rounded-full bg-gold/10 px-2 py-1 text-xs font-black text-gold-lt">{row.count}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="order-1 min-w-0 lg:order-none">
          {loading && !data ? <Skeleton className="h-96" /> : !approvals.length ? <Empty icon="◆" title="No approval requests" /> : (
            <div className="table-scroll min-w-0 max-w-full">
            <div className="md:min-w-[720px] divide-y divide-border">
              {approvals.map(row => {
                const ui = getRowUi(row.id)
                const rowBusy = isRowProcessing(row.id)
                const actionDisabled = rowBusy || actionsGloballyDisabled
                return (
                <div key={row.id} className={`relative grid gap-3 px-4 py-3 text-xs md:grid-cols-[1fr_0.8fr_1.2fr_0.9fr_1.1fr] ${approvalRowLockClass(ui)}`}>
                  {ui.state === 'processing' && (
                    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-black/40 backdrop-blur-[1px]">
                      <div className="flex items-center gap-2 rounded-xl border border-amber-500/40 bg-black/60 px-3 py-2 text-[11px] font-black text-amber-200">
                        <Spinner />
                        {ui.message || 'Processing approval…'}
                      </div>
                    </div>
                  )}
                  <div>
                    <p className="font-black text-cream">{row.type.replace(/_/g, ' ')}</p>
                    <p className="mt-1 text-muted">{row.module.replace(/_/g, ' ')} · {row.businessName || row.businessId || 'Global'}</p>
                    <p className="mt-1 text-muted">{new Date(row.createdAt).toLocaleString()}</p>
                  </div>
                  <RequesterIdentity requester={row.requester} fallbackName={row.requestedBy} avatarSize="sm" />
                  <div>
                    {row.type === 'SALARY_CORRECTION' ? (
                      <SalaryCorrectionCard
                        compact
                        payloadSnapshot={row.payloadSnapshot}
                        reason={row.reason}
                        requesterName={row.requester?.name}
                        createdAt={row.createdAt}
                        businessName={row.businessName}
                      />
                    ) : (
                      <>
                        <p className="font-bold text-muted-hi">{row.entityLabel || row.entityId}</p>
                        {row.type === 'ATTENDANCE_LEAVE' && <LeaveInfo payloadSnapshot={row.payloadSnapshot} />}
                        {row.type === 'PENALTY_APPEAL' && <PenaltyAppealInfo appeal={row.penaltyAppeal} />}
                        <p className="mt-1 line-clamp-2 text-muted">{row.reason}</p>
                      </>
                    )}
                    {(row.type === 'WALLET_ADVANCE' || row.type === 'WALLET_WITHDRAWAL' || row.type === 'SALARY_ADVANCE') && (
                      <PayoutSummaryBlock payout={row.payoutSummary} />
                    )}
                  </div>
                  <div>
                    <p className={`font-black ${row.priority === 'CRITICAL' ? 'text-red-500' : row.priority === 'HIGH' ? 'text-amber-600' : 'text-muted-hi'}`}>{row.priority}</p>
                    <p className={row.status === 'PENDING' ? 'mt-1 font-black text-gold-lt' : row.status === 'APPROVED' ? 'mt-1 font-black text-emerald-600' : 'mt-1 font-black text-red-500'}>{row.status}</p>
                    {row.linkageStatus === 'orphan_source_already_resolved' && (
                      <p className="mt-1 text-[10px] font-bold text-amber-600">
                        Payroll already {row.sourceStatus || 'resolved'} — reject will sync queue
                      </p>
                    )}
                    {row.linkageStatus === 'orphan_missing_source' && (
                      <p className="mt-1 text-[10px] font-bold text-red-500">Source record missing</p>
                    )}
                    {row.linkageStatus === 'orphan_missing_approval' && (
                      <p className="mt-1 text-[10px] font-bold text-red-500">Central approval missing — run Integrity repair</p>
                    )}
                    {lastAuditSource(row.auditHistory) && (
                      <p className="mt-1 text-[10px] font-bold uppercase tracking-wide text-muted">
                        via {lastAuditSource(row.auditHistory)}
                      </p>
                    )}
                    <ApprovalRowProcessingBadge ui={ui} />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="xs" variant="ghost" disabled={rowBusy} onClick={() => setSelected(row)}>View Details</Button>
                    {row.status === 'PENDING' && row.executable && (
                      <Button size="xs" variant="gold" disabled={actionDisabled} onClick={() => handleApproveClick(row)}>
                        {ui.state === 'processing' ? 'Processing' : 'Approve'}
                      </Button>
                    )}
                    {row.status === 'PENDING' && (
                      <Button size="xs" variant="danger" disabled={actionDisabled} onClick={() => { if (!actionDisabled) { setActionTarget({ row, action: 'REJECT' }); setNote('') } }}>
                        Reject
                      </Button>
                    )}
                    {(ui.state === 'failed' || ui.state === 'rolled_back') && (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={actionDisabled}
                        onClick={() => void processApproval(row, ui.action || 'APPROVE')}
                      >
                        Retry
                      </Button>
                    )}
                    {row.status === 'PENDING' && !row.executable && <span className="text-[10px] font-bold text-amber-600">Manual review</span>}
                  </div>
                </div>
              )})}
            </div>
            </div>
          )}
        </Card>
      </div>
      </motion.div>

      {selected && (() => {
        const selectedUi = getRowUi(selected.id)
        const selectedBusy = isRowProcessing(selected.id)
        const selectedActionDisabled = selectedBusy || actionsGloballyDisabled
        return (
        <MobileModalPortal open zIndex={10000} onBackdropClick={() => setSelected(null)}>
          <Card className={`mobile-modal-shell w-full max-w-2xl sm:rounded-2xl ${approvalRowLockClass(selectedUi)}`}>
            <div className="mobile-modal-header p-5 pb-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-black text-cream">{selected.type.replace(/_/g, ' ')}</p>
                  <p className="mt-1 text-xs text-muted">{selected.module} · {new Date(selected.createdAt).toLocaleString()}</p>
                </div>
                <Button size="xs" variant="ghost" disabled={selectedBusy} onClick={() => setSelected(null)}>Close</Button>
              </div>
              {selectedUi.state === 'processing' && (
                <div className="mt-4 flex items-center gap-2 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-200">
                  <Spinner />
                  {selectedUi.message || 'Processing approval…'}
                </div>
              )}
            </div>
            <div className="mobile-modal-body px-5 pb-4">
              <div className="rounded-2xl border border-border bg-white/[0.04] p-3">
                <RequesterIdentity requester={selected.requester} fallbackName={selected.requestedBy} avatarSize="lg" large />
              </div>
              <div className="mt-3 space-y-3 text-xs">
                <Info label="Status" value={selected.status} />
                <Info label="Priority" value={selected.priority} />
                <Info label="Business" value={selected.businessName || selected.businessId || 'Global'} />
                {selected.type === 'SALARY_CORRECTION' ? (
                  <SalaryCorrectionCard
                    payloadSnapshot={selected.payloadSnapshot}
                    reason={selected.reason}
                    requesterName={selected.requester?.name}
                    createdAt={selected.createdAt}
                    businessName={selected.businessName}
                    priority={selected.priority}
                  />
                ) : (
                  <>
                    <Info label="Entity / account affected" value={selected.entityLabel || selected.entityId} />
                    {selected.type === 'ATTENDANCE_LEAVE' && (
                      <Info label="ছুটির সময়কাল" value={<LeaveInfo payloadSnapshot={selected.payloadSnapshot} />} />
                    )}
                    {selected.type === 'PENALTY_APPEAL' && (
                      <Info label="কোন জরিমানার আপিল" value={<PenaltyAppealInfo appeal={selected.penaltyAppeal} />} />
                    )}
                    <Info label="Reason" value={selected.reason} />
                    {(selected.type === 'WALLET_ADVANCE' || selected.type === 'WALLET_WITHDRAWAL' || selected.type === 'SALARY_ADVANCE') && (
                      <div className="rounded-2xl border border-border bg-white/[0.04] p-3">
                        <PayoutSummaryBlock payout={selected.payoutSummary} />
                      </div>
                    )}
                    <pre className="max-h-64 overflow-auto rounded-2xl border border-border bg-white/[0.04] p-3 text-[11px] text-muted-hi">{JSON.stringify({ payloadSnapshot: selected.payloadSnapshot, auditHistory: selected.auditHistory }, null, 2)}</pre>
                  </>
                )}
              </div>
            </div>
            <div className="mobile-modal-footer px-5 pt-3">
              <div className="flex flex-wrap gap-2">
                {selected.status === 'PENDING' && selected.executable && (
                  <Button variant="gold" disabled={selectedActionDisabled} onClick={() => handleApproveClick(selected)}>
                    {selectedUi.state === 'processing' ? <><Spinner /> Processing approval…</> : 'Approve'}
                  </Button>
                )}
                {selected.status === 'PENDING' && (
                  <Button variant="danger" disabled={selectedActionDisabled} onClick={() => { if (!selectedActionDisabled) { setActionTarget({ row: selected, action: 'REJECT' }); setNote('') } }}>
                    Reject
                  </Button>
                )}
                {(selectedUi.state === 'failed' || selectedUi.state === 'rolled_back') && (
                  <Button variant="ghost" disabled={selectedActionDisabled} onClick={() => void processApproval(selected, selectedUi.action || 'APPROVE')}>
                    Retry safely
                  </Button>
                )}
                {selected.actionUrl && <a href={selected.actionUrl} className="inline-flex rounded-xl border border-gold-dim/40 px-3 py-2 font-bold text-gold-lt">Open related record</a>}
              </div>
            </div>
          </Card>
        </MobileModalPortal>
        )
      })()}
      {actionTarget && (() => {
        const rejectUi = getRowUi(actionTarget.row.id)
        const rejectBusy = isRowProcessing(actionTarget.row.id)
        const rejectActionDisabled = rejectBusy || actionsGloballyDisabled
        return (
        <MobileModalPortal open zIndex={10001} onBackdropClick={() => setActionTarget(null)}>
          <Card className="mobile-modal-shell w-full max-w-lg sm:rounded-2xl">
            <div className="mobile-modal-header p-5 pb-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-black text-cream">Reject Approval</p>
                  <p className="mt-1 text-xs text-muted">{actionTarget.row.type.replace(/_/g, ' ')} · {actionTarget.row.requester?.name || actionTarget.row.requestedBy}</p>
                </div>
                <Button size="xs" variant="ghost" disabled={rejectBusy} onClick={() => setActionTarget(null)}>Close</Button>
              </div>
              {rejectUi.state === 'processing' && (
                <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-200">
                  <Spinner />
                  Processing rejection…
                </div>
              )}
            </div>
            <div className="mobile-modal-body px-5 space-y-2">
              <textarea
                value={note}
                onChange={e => setNote(e.target.value)}
                disabled={rejectActionDisabled}
                minLength={5}
                className="min-h-28 w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-cream outline-none focus:border-gold-dim/60 disabled:opacity-60"
                placeholder="Rejection reason required (min. 5 characters)"
              />
              <p className={`text-[11px] ${note.trim().length < 5 ? 'text-amber-600' : 'text-muted'}`}>
                {note.trim().length < 5
                  ? `${5 - note.trim().length} more character(s) required`
                  : 'Reason will be stored on the approval record.'}
              </p>
            </div>
            <div className="mobile-modal-footer px-5 pt-3">
              <Button
                variant="danger"
                className="w-full justify-center"
                disabled={rejectActionDisabled || note.trim().length < 5}
                onClick={() => void processApproval(actionTarget.row, 'REJECT', note)}
              >
                {rejectUi.state === 'processing' ? <><Spinner /> Processing rejection…</> : 'Reject request'}
              </Button>
            </div>
          </Card>
        </MobileModalPortal>
        )
      })()}
      {withdrawApprove && (() => {
        const waUi = getRowUi(withdrawApprove.row.id)
        const waBusy = isRowProcessing(withdrawApprove.row.id)
        const waDisabled = waBusy || actionsGloballyDisabled
        const txn = withdrawApprove.transactionId.trim()
        return (
        <MobileModalPortal open zIndex={10001} onBackdropClick={dismissWithdrawModal}>
          <Card className="mobile-modal-shell w-full max-w-lg sm:rounded-2xl">
            <div className="mobile-modal-header p-5 pb-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-black text-cream">Approve withdrawal</p>
                  <p className="mt-1 text-xs text-muted">{withdrawApprove.row.requester?.name || withdrawApprove.row.requestedBy} · {withdrawApprove.row.businessName || withdrawApprove.row.businessId || 'Global'}</p>
                </div>
                <Button size="xs" variant="ghost" disabled={waBusy} onClick={dismissWithdrawModal}>Close</Button>
              </div>
              {waUi.state === 'processing' && (
                <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-200">
                  <Spinner />
                  Processing approval…
                </div>
              )}
            </div>
            <div className="mobile-modal-body px-5 space-y-2">
              {(() => {
                const number = bkashPayoutNumber(withdrawApprove.row)
                if (!number) return null
                return (
                  <div className="rounded-xl border border-gold/25 bg-gold/[0.06] p-3">
                    <p className="text-[11px] font-bold text-cream">
                      {withdrawApprove.resumedFromBkash
                        ? 'বিকাশ থেকে ফিরেছেন — TrxID পেস্ট করে অনুমোদন শেষ করুন'
                        : `প্রাপকের বিকাশ${withdrawApprove.row.payoutSummary?.accountHolder ? ` · ${withdrawApprove.row.payoutSummary.accountHolder}` : ''}`}
                    </p>
                    <p className="mt-1 font-mono text-sm font-bold text-gold">{number}</p>
                    {!withdrawApprove.resumedFromBkash && (
                      <div className="mt-2">
                        {/* A real link, not a button: iOS opens a Universal Link most
                            reliably from an actual anchor tap. onClick only copies —
                            the browser does the navigation. */}
                        <a
                          href={BKASH_APP_URL}
                          onClick={() => { if (!waDisabled) startBkashSend() }}
                          aria-disabled={waDisabled}
                          className={`inline-flex items-center gap-1.5 rounded-full bg-gold px-4 py-2 text-xs font-bold text-white transition hover:bg-gold-dim ${waDisabled ? 'pointer-events-none opacity-60' : ''}`}
                        >
                          নম্বর কপি করে বিকাশ খুলুন →
                        </a>
                      </div>
                    )}
                    <span className="mt-2 block text-[10px] text-muted">
                      {withdrawApprove.resumedFromBkash
                        ? 'বিকাশের সফল স্ক্রিন থেকে TrxID কপি করে নিচের "পেস্ট" বাটন চাপুন।'
                        : 'টাকা পাঠিয়ে অ্যাপে ফিরে এলে এই ঘরটাই আবার খুলবে — তখন TrxID পেস্ট করলেই শেষ।'}
                    </span>
                  </div>
                )
              })()}
              <label className="block text-[11px] font-black uppercase tracking-[0.14em] text-muted">
                Transaction ID
                <div className="mt-2 flex gap-2">
                  <input
                    autoFocus={!withdrawApprove.resumedFromBkash}
                    type="text"
                    value={withdrawApprove.transactionId}
                    onChange={e => setWithdrawApprove(w => w ? { ...w, transactionId: e.target.value } : w)}
                    disabled={waDisabled}
                    placeholder="যে নম্বর/ID থেকে টাকা পাঠালেন"
                    className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-cream outline-none focus:border-gold-dim/60 disabled:opacity-60"
                  />
                  {bkashPayoutNumber(withdrawApprove.row) && (
                    <button
                      type="button"
                      disabled={waDisabled}
                      onClick={() => void pasteTrxId()}
                      className="shrink-0 rounded-xl border border-gold/40 bg-gold/10 px-4 text-xs font-bold text-gold transition hover:bg-gold/20 disabled:opacity-60"
                    >
                      পেস্ট
                    </button>
                  )}
                </div>
              </label>
              <p className={`text-[11px] ${!txn ? 'text-amber-600' : 'text-muted'}`}>
                {!txn ? 'Transaction ID আবশ্যক' : 'এই ID সহ staff-কে SMS পাঠানো হবে।'}
              </p>
            </div>
            <div className="mobile-modal-footer px-5 pt-3">
              <Button
                variant="gold"
                className="w-full justify-center"
                disabled={waDisabled || !txn}
                onClick={() => void processApproval(withdrawApprove.row, 'APPROVE', '', txn)}
              >
                {waUi.state === 'processing' ? <><Spinner /> Processing approval…</> : 'Confirm approval'}
              </Button>
            </div>
          </Card>
        </MobileModalPortal>
        )
      })()}
      {reimburseApprove && (() => {
        const raUi = getRowUi(reimburseApprove.id)
        const raBusy = isRowProcessing(reimburseApprove.id)
        const raDisabled = raBusy || actionsGloballyDisabled
        const snap = (reimburseApprove.payloadSnapshot && typeof reimburseApprove.payloadSnapshot === 'object'
          ? reimburseApprove.payloadSnapshot
          : {}) as Record<string, unknown>
        const raAmount = Number(snap.reimburse_amount || snap.amount || 0)
        return (
        <MobileModalPortal open zIndex={10001} onBackdropClick={() => { if (!raBusy) setReimburseApprove(null) }}>
          <Card className="mobile-modal-shell w-full max-w-lg sm:rounded-2xl">
            <div className="mobile-modal-header p-5 pb-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-black text-cream">অনুমোদন — টাকাটা কীভাবে দেবেন?</p>
                  <p className="mt-1 text-xs text-muted">
                    {reimburseApprove.requester?.name || reimburseApprove.requestedBy} · ৳{raAmount.toLocaleString('en-IN')} · {String(snap.category || 'Reimbursement')}
                  </p>
                </div>
                <Button size="xs" variant="ghost" disabled={raBusy} onClick={() => setReimburseApprove(null)}>Close</Button>
              </div>
              {raUi.state === 'processing' && (
                <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-200">
                  <Spinner />
                  Processing approval…
                </div>
              )}
            </div>
            <div className="mobile-modal-body space-y-2 px-5">
              <button
                type="button"
                disabled={raDisabled}
                onClick={() => void processApproval(reimburseApprove, 'APPROVE', '', undefined, 'wallet')}
                className="flex w-full items-center gap-3 rounded-2xl border border-border bg-white/[0.04] px-4 py-3 text-left transition hover:border-gold-dim/60 disabled:opacity-60"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gold/15 text-lg">👛</span>
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-cream">ওয়ালেটে যোগ করুন</span>
                  <span className="block text-[11px] text-muted">স্টাফের ERP ওয়ালেটে জমা হবে, বেতনের সাথে পাবে</span>
                </span>
              </button>
              <button
                type="button"
                disabled={raDisabled}
                onClick={() => void processApproval(reimburseApprove, 'APPROVE', '', undefined, 'instant')}
                className="flex w-full items-center gap-3 rounded-2xl border border-border bg-white/[0.04] px-4 py-3 text-left transition hover:border-gold-dim/60 disabled:opacity-60"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gold/15 text-lg">⚡️</span>
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-cream">এখনই পেমেন্ট (ক্যাশ / বিকাশ)</span>
                  <span className="block text-[11px] text-muted">সাথে সাথে দিয়ে দিয়েছেন — ওয়ালেটে যোগ হবে না, খরচ রেকর্ড হবে</span>
                </span>
              </button>
            </div>
            <div className="mobile-modal-footer px-5 pt-3">
              <Button variant="ghost" className="w-full justify-center" disabled={raBusy} onClick={() => setReimburseApprove(null)}>
                বাতিল
              </Button>
            </div>
          </Card>
        </MobileModalPortal>
        )
      })()}
      </motion.div>
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

function RequesterIdentity({
  requester,
  fallbackName,
  avatarSize,
  large,
}: {
  requester?: ApprovalRow['requester']
  fallbackName: string
  avatarSize: 'sm' | 'lg'
  large?: boolean
}) {
  const name = requester?.name || fallbackName
  const role = requester?.role?.replace(/_/g, ' ') || 'Requester'
  const empId = requester?.employeeIdGas
  const body = (
    <div className="flex items-center gap-2">
      <EmployeeAvatar userId={requester?.id} name={name} imageUrl={requester?.profileImageUrl} size={avatarSize} />
      <div>
        <p className={large ? 'text-sm font-bold text-cream' : 'font-bold text-muted-hi'}>{name}</p>
        <p className={large ? 'text-[11px] text-muted' : 'mt-1 text-muted'}>{role}</p>
      </div>
    </div>
  )
  if (!empId) return body
  return (
    <Link
      href={`/employees/${encodeURIComponent(empId)}`}
      className="inline-flex rounded-xl transition-colors hover:bg-white/[0.04]"
      title="View employee profile"
    >
      {body}
    </Link>
  )
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="rounded-2xl border border-border bg-white/[0.04] p-3"><p className="text-[10px] font-black uppercase tracking-[0.14em] text-muted">{label}</p><p className="mt-1 font-bold text-cream">{value}</p></div>
}

/** Minutes-since-midnight → "2:00 PM". */
function fmtLeaveTime(m?: number | null): string {
  if (m == null) return ''
  const h = Math.floor(m / 60), mm = m % 60
  const ap = h >= 12 ? 'PM' : 'AM'
  const h12 = ((h + 11) % 12) + 1
  return `${h12}:${String(mm).padStart(2, '0')} ${ap}`
}

/**
 * Leave request duration/times — surfaced on the ATTENDANCE_LEAVE approval card so the
 * owner (and staff, via the same snapshot) can see how many days / hours and the
 * start–end time, not just the reason. Reads the payloadSnapshot the request already stores.
 */
function LeaveInfo({ payloadSnapshot }: { payloadSnapshot: unknown }) {
  const p = (payloadSnapshot && typeof payloadSnapshot === 'object' ? payloadSnapshot : {}) as {
    kind?: string; startDate?: string; endDate?: string
    startMinutes?: number | null; endMinutes?: number | null; days?: number
  }
  if (!p.startDate && p.kind == null) return null
  const dateRange = p.startDate && p.endDate && p.startDate !== p.endDate
    ? `${p.startDate} – ${p.endDate}` : (p.startDate ?? '')
  let duration: string
  if (p.kind === 'HOURS') duration = `⏰ ${fmtLeaveTime(p.startMinutes)} – ${fmtLeaveTime(p.endMinutes)} (ঘণ্টাভিত্তিক ছুটি)`
  else if (p.kind === 'SHIFTED_START') duration = `⏰ ${fmtLeaveTime(p.startMinutes)} থেকে দেরিতে শুরু`
  else duration = `🗓️ ${p.days ?? 1} দিন${p.kind === 'DATE_RANGE' ? ' (কয়েকদিন)' : ''}`
  return (
    <div className="mt-1.5 space-y-0.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-2.5 py-1.5 text-[13px]">
      {dateRange && <p className="font-bold text-cream">📅 {dateRange}</p>}
      <p className="font-semibold text-amber-500">{duration}</p>
    </div>
  )
}

/**
 * The fine behind a PENALTY_APPEAL — which day, why it was levied, how much, and
 * what relief the staff asked for. Without this the row's createdAt (the appeal
 * submission time) reads like the fine happened today (owner report 2026-07-15).
 */
function PenaltyAppealInfo({ appeal }: { appeal: ApprovalRow['penaltyAppeal'] }) {
  if (!appeal?.fineDate) return null
  const fineDay = new Date(appeal.fineDate).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', weekday: 'short', timeZone: 'Asia/Dhaka',
  })
  const time = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Dhaka' }) : null
  let story: string
  if (appeal.fineKind === 'LATE') {
    story = `দেরিতে চেক-ইন${appeal.lateMinutes ? ` — ${appeal.lateMinutes} মিনিট দেরি` : ''}${time(appeal.checkInAt) ? ` (চেক-ইন ${time(appeal.checkInAt)})` : ''}`
  } else if (appeal.fineKind === 'EARLY_LEAVE') {
    story = `নির্ধারিত সময়ের আগে বের হওয়া${appeal.earlyLeaveMinutes ? ` — ${appeal.earlyLeaveMinutes} মিনিট আগে` : ''}${time(appeal.checkOutAt) ? ` (চেক-আউট ${time(appeal.checkOutAt)})` : ''}`
  } else if (appeal.fineKind === 'NO_CHECKOUT') {
    story = 'চেক-আউট দেওয়া হয়নি'
  } else {
    story = 'অ্যাটেনডেন্স জরিমানা'
  }
  const relief = appeal.requestType === 'PARTIAL_REDUCE'
    ? `৳${(appeal.requestedReductionAmount ?? 0).toLocaleString('en-BD')} কমানো`
    : appeal.requestType === 'RECONSIDERATION' ? 'পুনর্বিবেচনা' : 'পুরো মাফ'
  return (
    <div className="mt-1.5 space-y-0.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-2.5 py-1.5 text-[13px]">
      <p className="font-bold text-cream">📅 জরিমানার দিন: {fineDay}</p>
      <p className="font-semibold text-amber-500">{story}</p>
      <p className="font-semibold text-cream">
        জরিমানা ৳{(appeal.originalPenaltyAmount ?? 0).toLocaleString('en-BD')} · চাওয়া: {relief}
      </p>
      {appeal.appealSubmittedAt && (
        <p className="text-[11px] text-muted">আপিল জমা: {new Date(appeal.appealSubmittedAt).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}</p>
      )}
    </div>
  )
}

function IntegrityStat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-white/[0.04] px-3 py-2">
      <p className="text-[10px] font-black uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-lg font-black ${warn && value > 0 ? 'text-amber-600' : 'text-cream'}`}>{value}</p>
    </div>
  )
}
