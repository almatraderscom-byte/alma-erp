'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { motion, type Variants } from 'framer-motion'
import toast from 'react-hot-toast'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import { Button, Card, Empty, KpiCard, Skeleton, KPI_AUTO_GRID } from '@/components/ui'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { PageEnter } from '@/components/layout/AgentAccess'
import { useBusiness } from '@/contexts/BusinessContext'
import { useActor } from '@/contexts/ActorContext'
import { EmployeeAvatar } from '@/components/profile/EmployeeAvatar'
import { useRegisterMobileRefresh } from '@/hooks/useRegisterMobileRefresh'
import { safeFetchJson, safeFetchJsonWithToast } from '@/lib/safe-fetch'
import { unwrapApiData } from '@/lib/safe-api-response'
import { SectionErrorBoundary } from '@/components/runtime/SectionErrorBoundary'
const _stagger: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } }
const _fadeUp: Variants = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: [0.22, 1, 0.36, 1] } } }

type AttendanceDashboard = {
  businessId?: string
  businessIds?: string[]
  scopeAllBusinesses?: boolean
  integrity?: {
    issueCount: number
    issues: Array<{ kind: string; businessId?: string; todayCount?: number; employeeId?: string; name?: string }>
    crossBusinessHint?: Array<{ businessId: string; todayCount: number }>
  }
  kpis: {
    employeeCount: number
    todayAttendance: number
    absentEmployees: number
    lateEmployees: number
    todayPenaltyTotal: number
    monthPenaltyTotal: number
    attendanceRate: number
    pendingWaivers: number
    suspiciousAttendance: number
    pendingVerifications: number
  }
  records: Array<{
    id: string
    businessId?: string
    userId: string
    employeeId: string
    employeeName: string
    profileImageUrl?: string | null
    checkInAt: string
    checkOutAt: string | null
    totalWorkMinutes: number
    lateMinutes: number
    penaltyAmount: number
    trustStatus: string
    suspiciousReasons: string[]
    verificationRequired: boolean
    selfieCount: number
  }>
  absentEmployees: Array<{ id: string; employeeId: string | null; name: string; email: string | null; profileImageUrl?: string | null }>
  pendingWaivers: Array<{
    id: string
    businessId: string
    employeeId: string
    requesterUserId?: string
    requesterName: string
    requesterProfileImageUrl?: string | null
    requestType?: string
    originalPenaltyAmount: number
    requestedReductionAmount: number | null
    finalAppliedPenalty?: number
    reason: string
    hasAttachment?: boolean
    createdAt: string
    lateMinutes: number
    penaltyKind?: 'LATE' | 'EARLY_LEAVE' | 'NO_CHECKOUT'
    penaltyMinutes?: number | null
    reviewContext?: {
      exception: { status: string; scope: string; reason: string; adminNote?: string | null } | null
      leave: { status: string; kind: string; reason: string; adminNote?: string | null } | null
    }
    attachmentUrl?: string | null
  }>
  recentWaiverDecisions: Array<{
    id: string
    employeeId: string
    requesterName: string
    requesterUserId?: string
    requesterProfileImageUrl?: string | null
    status: string
    originalPenaltyAmount: number
    requestedReductionAmount: number | null
    approvedReductionAmount: number | null
    finalAppliedPenalty: number
    reason: string
    adminNote?: string | null
    reviewerName?: string | null
    reviewedAt?: string | null
    attendanceDate: string
    penaltyKind: 'LATE' | 'EARLY_LEAVE' | 'NO_CHECKOUT'
    reversalLedgerEntryId?: string | null
    refundAmount: number
    refundReconciled: boolean
    refundIssue?: string | null
    attachmentUrl?: string | null
  }>
  selfieLogs: Array<{
    id: string
    businessId: string
    attendanceRecordId: string
    employeeId: string
    capturedAt: string
    sizeBytes: number
    imageDataUrl: string
    imageUrl?: string | null
    imageMissing?: boolean
    reviewedAt: string | null
  }>
  ranking: Array<{
    userId?: string
    employeeId: string | null
    name: string
    profileImageUrl?: string | null
    presentDays: number
    lateCount: number
    penaltyTotal: number
    averageWorkLabel: string
    punctualityScore: number
  }>
}

type ReviewState = {
  id: string
  businessId: string
  employeeId: string
  originalPenalty: number
  requestedAmount: number
  amount: string
  action: 'APPROVE' | 'REJECT'
  note: string
  reason: string
  penaltyKind?: 'LATE' | 'EARLY_LEAVE' | 'NO_CHECKOUT'
  createdAt: string
  attachmentUrl?: string | null
  reviewContext?: AttendanceDashboard['pendingWaivers'][number]['reviewContext']
} | null

type PenaltyAnalytics = {
  totalPenalties: number
  waivedAmount: number
  reducedAmount: number
  netPenaltiesAfterWaivers: number
  appealCount: number
  pendingCount: number
  approvalRate: number
  reconciliationIssues?: number
  repeatOffenders: Array<{ employeeId: string; penaltyCount: number; penaltyTotal: number }>
}

export default function AttendancePage() {
  return (
    <SectionErrorBoundary section="attendance" title="Attendance dashboard unavailable">
      <AttendancePageInner />
    </SectionErrorBoundary>
  )
}

function AttendancePageInner() {
  const { business } = useBusiness()
  const { role } = useActor()
  const searchParams = useSearchParams()
  const [data, setData] = useState<AttendanceDashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [analytics, setAnalytics] = useState<PenaltyAnalytics | null>(null)
  const [review, setReview] = useState<ReviewState>(null)
  const canReview = role === 'SUPER_ADMIN' || role === 'ADMIN'
  const [viewAllBusinesses, setViewAllBusinesses] = useState(role === 'SUPER_ADMIN')
  const [showIntegrity, setShowIntegrity] = useState(false)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [resettingRecordId, setResettingRecordId] = useState<string | null>(null)
  const canResetAttendance = role === 'SUPER_ADMIN'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const bizParam = viewAllBusinesses && role === 'SUPER_ADMIN' ? 'ALL' : business.id
      const result = await safeFetchJson<AttendanceDashboard>(
        `/api/attendance?business_id=${encodeURIComponent(bizParam)}`,
        { cache: 'no-store' },
      )
      if (!result.ok) throw new Error(result.error.message)
      setData(unwrapApiData<AttendanceDashboard>(result.data as Record<string, unknown>))
    } catch (e) {
      toast.error((e as Error).message || 'Could not load attendance')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [business.id, viewAllBusinesses, role])

  const loadAnalytics = useCallback(async () => {
    if (!canReview) return
    try {
      const result = await safeFetchJsonWithToast<{ analytics: PenaltyAnalytics }>(
        `/api/attendance/waivers/analytics?business_id=${business.id}`,
        { cache: 'no-store', toastOnError: false },
      )
      if (result.ok) setAnalytics(result.data.analytics)
    } catch {
      setAnalytics(null)
    }
  }, [business.id, canReview])

  useEffect(() => {
    void load()
    void loadAnalytics()
  }, [load, loadAnalytics])

  useRegisterMobileRefresh(
    useCallback(async () => {
      await load()
      await loadAnalytics()
    }, [load, loadAnalytics]),
  )

  const reviewId = searchParams.get('review')
  const openReviewFromUrl = useMemo(() => {
    if (!reviewId || !data?.pendingWaivers?.length) return null
    return data.pendingWaivers.find(w => w.id === reviewId) || null
  }, [reviewId, data?.pendingWaivers])

  const startPenaltyReview = useCallback((
    waiver: AttendanceDashboard['pendingWaivers'][number],
    action: 'APPROVE' | 'REJECT',
  ) => {
    setReview({
      id: waiver.id,
      businessId: waiver.businessId,
      employeeId: waiver.employeeId,
      originalPenalty: Number(waiver.originalPenaltyAmount),
      requestedAmount: Number(waiver.requestedReductionAmount ?? waiver.originalPenaltyAmount),
      amount: String(waiver.requestedReductionAmount ?? waiver.originalPenaltyAmount),
      action,
      note: '',
      reason: waiver.reason,
      penaltyKind: waiver.penaltyKind,
      createdAt: waiver.createdAt,
      attachmentUrl: waiver.attachmentUrl,
      reviewContext: waiver.reviewContext,
    })
  }, [])

  useEffect(() => {
    if (!openReviewFromUrl || review) return
    startPenaltyReview(openReviewFromUrl, 'APPROVE')
  }, [openReviewFromUrl, review, startPenaltyReview])

  async function submitReview() {
    if (!review || reviewBusy) return
    if (review.action === 'REJECT' && review.note.trim().length < 5) {
      toast.error('প্রত্যাখ্যানের কারণ লিখুন (অন্তত ৫ অক্ষর)।')
      return
    }
    const approvedAmount = Number(review.amount)
    if (review.action === 'APPROVE' && (
      !Number.isFinite(approvedAmount)
      || approvedAmount <= 0
      || approvedAmount > review.requestedAmount
      || approvedAmount > review.originalPenalty
    )) {
      toast.error(`Wallet credit must be between ৳0.01 and ৳${review.requestedAmount.toLocaleString('en-BD')}.`)
      return
    }
    setReviewBusy(true)
    try {
      const result = await safeFetchJsonWithToast(
        `/api/attendance/waivers/${review.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            business_id: review.businessId,
            action: review.action,
            approved_reduction_amount: review.action === 'APPROVE' ? approvedAmount : undefined,
            admin_note: review.note,
          }),
        },
      )
      if (!result.ok) return
      toast.success(review.action === 'APPROVE'
        ? `${approvedAmount < review.originalPenalty ? 'Partial' : 'Full'} approval — ৳${approvedAmount.toLocaleString('en-BD')} credited to wallet`
        : 'Penalty appeal rejected')
      setReview(null)
      void load()
      void loadAnalytics()
    } finally {
      setReviewBusy(false)
    }
  }

  async function requestVerification(recordId: string) {
    const result = await safeFetchJsonWithToast(
      `/api/attendance/${recordId}/verification-request`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id }),
      },
    )
    if (!result.ok) return
    toast.success('Verification requested — employee will see Verify Face Now on My Desk')
    void load()
  }

  async function resetAttendance(recordId: string, employeeName: string) {
    if (!canResetAttendance || resettingRecordId) return
    const ok = await confirmDialog({ message: `Remove ${employeeName}'s attendance for today? They can check in again; any late penalty will be reversed.`, confirmLabel: 'Remove', danger: true })
    if (!ok) return
    setResettingRecordId(recordId)
    try {
      const result = await safeFetchJsonWithToast(`/api/attendance/${encodeURIComponent(recordId)}`, {
        method: 'DELETE',
      })
      if (!result.ok) return
      toast.success('Attendance reset — employee can check in again')
      void load()
      void loadAnalytics()
    } finally {
      setResettingRecordId(null)
    }
  }

  async function reviewSelfie(
    selfieId: string,
    selfieBusinessId: string,
    action: 'APPROVE' | 'REJECT',
  ) {
    const result = await safeFetchJsonWithToast(`/api/attendance/selfies/${selfieId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_id: selfieBusinessId, action }),
    })
    if (!result.ok) return
    toast.success(action === 'APPROVE' ? 'Verification approved' : 'Verification rejected')
    void load()
  }

  const pendingSelfieReviews = useMemo(
    () => (data?.selfieLogs ?? []).filter(log => !log.reviewedAt),
    [data?.selfieLogs],
  )

  const k = data?.kpis

  return (
    <FinancePageChrome
      title="Attendance"
      subtitle="Office time, late penalties, wallet deductions, and penalty review queue"
      actions={
        <div className="flex gap-2 flex-wrap justify-end">
          {role === 'SUPER_ADMIN' && (
            <Button
              size="xs"
              variant={viewAllBusinesses ? 'gold' : 'secondary'}
              onClick={() => setViewAllBusinesses(v => !v)}
            >
              {viewAllBusinesses ? 'All businesses' : business.shortName}
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={() => setShowIntegrity(v => !v)}>Integrity</Button>
          <Link href="/portal"><Button size="xs" variant="secondary">My desk</Button></Link>
          <Button size="xs" variant="gold" onClick={() => void load()}>Refresh</Button>
        </div>
      }
    >
      <PageEnter className="min-w-0 max-w-full space-y-5">
      {!loading && !data && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border tone-red px-4 py-3 text-sm">
          <span>Could not load attendance dashboard</span>
          <Button variant="ghost" size="xs" onClick={() => void load()}>Retry</Button>
        </div>
      )}

      {showIntegrity && data?.integrity && (
        <Card className="p-5 border-amber-500/35 bg-amber-500/10">
          <p className="text-sm font-bold text-cream">Attendance Integrity Monitor</p>
          <p className="mt-1 text-xs text-muted">
            {data.scopeAllBusinesses ? 'Viewing all businesses' : `Scoped to ${business.name}`}
            {' · '}{data.integrity.issueCount} issue(s)
          </p>
          {(data.integrity.crossBusinessHint ?? []).length > 0 && !viewAllBusinesses && (
            <p className="mt-2 text-xs font-bold text-amber-600">
              Activity today in other businesses:{' '}
              {data.integrity.crossBusinessHint!.map(h => `${h.businessId} (${h.todayCount})`).join(', ')}
              {' — '}use <strong>All businesses</strong> to view.
            </p>
          )}
          {data.integrity.issueCount > 0 && (
            <ul className="mt-3 max-h-32 space-y-1 overflow-y-auto [-webkit-overflow-scrolling:touch] overscroll-contain text-[11px] text-muted-hi">
              {data.integrity.issues.map((row, i) => (
                <li key={`${row.kind}-${i}`}>
                  {row.kind.replace(/_/g, ' ')}
                  {row.businessId ? ` · ${row.businessId}` : ''}
                  {row.employeeId ? ` · ${row.employeeId}` : ''}
                  {row.name ? ` · ${row.name}` : ''}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* Summary Bar */}
      {!loading && k && (
        <motion.div
          className="grid grid-cols-3 gap-3"
          variants={_stagger} initial="hidden" animate="show"
        >
          <motion.div variants={_fadeUp}>
            <Card className="p-4 text-center border-emerald-500/25">
              <div className="inline-flex w-10 h-10 items-center justify-center rounded-full bg-emerald-500/10 mb-2">
                <svg className="w-5 h-5 text-emerald-600" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>
              </div>
              <p className="text-2xl font-bold text-emerald-600">{k.todayAttendance}</p>
              <p className="text-xs text-muted mt-1">Present</p>
            </Card>
          </motion.div>
          <motion.div variants={_fadeUp}>
            <Card className="p-4 text-center border-red-500/25">
              <div className="inline-flex w-10 h-10 items-center justify-center rounded-full bg-red-500/10 mb-2">
                <svg className="w-5 h-5 text-red-500" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" /></svg>
              </div>
              <p className="text-2xl font-bold text-red-600">{k.absentEmployees}</p>
              <p className="text-xs text-muted mt-1">Absent</p>
            </Card>
          </motion.div>
          <motion.div variants={_fadeUp}>
            <Card className="p-4 text-center border-amber-500/25">
              <div className="inline-flex w-10 h-10 items-center justify-center rounded-full bg-amber-500/10 mb-2">
                <svg className="w-5 h-5 text-amber-600" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" /></svg>
              </div>
              <p className="text-2xl font-bold text-amber-600">{k.lateEmployees}</p>
              <p className="text-xs text-muted mt-1">Late</p>
            </Card>
          </motion.div>
        </motion.div>
      )}

      <div className={KPI_AUTO_GRID}>
        <KpiCard label="Today penalties" value={k?.todayPenaltyTotal ?? 0} valueKind="currency" color="text-red-400" loading={loading} animate />
        <KpiCard label="Employee scope" value={k?.employeeCount ?? 0} valueKind="plain" loading={loading} animate />
        <KpiCard label="Monthly attendance" value={loading ? '—' : `${Number(k?.attendanceRate ?? 0)}%`} valueKind="plain" loading={loading} animate />
        <KpiCard label="Monthly penalties" value={k?.monthPenaltyTotal ?? 0} valueKind="currency" color="text-red-400" loading={loading} animate />
        <KpiCard label="Pending reviews" value={k?.pendingWaivers ?? 0} valueKind="plain" color="text-gold-lt" loading={loading} animate />
        <KpiCard label="Security flags" value={k?.suspiciousAttendance ?? 0} valueKind="plain" color="text-amber-300" loading={loading} animate />
        <KpiCard label="Verification due" value={k?.pendingVerifications ?? 0} valueKind="plain" color="text-amber-300" loading={loading} animate />
      </div>

      {canReview && analytics && (
        <Card className="p-5">
          <p className="text-sm font-bold text-cream mb-3">Penalty appeal analytics (this month)</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px]">
            <AnalyticsStat label="Total penalties" value={money(analytics.totalPenalties)} tone="text-red-600" />
            <AnalyticsStat label="Waived / reduced" value={money(analytics.waivedAmount)} tone="text-emerald-600" />
            <AnalyticsStat label="Net after appeals" value={money(analytics.netPenaltiesAfterWaivers)} />
            <AnalyticsStat label="Approval rate" value={`${analytics.approvalRate}%`} tone="text-gold" />
          </div>
          {analytics.repeatOffenders.length > 0 && (
            <p className="mt-3 text-[10px] text-muted">
              Repeat attendance penalties: {analytics.repeatOffenders.slice(0, 4).map(r => `${r.employeeId} (${money(r.penaltyTotal)})`).join(' · ')}
            </p>
          )}
          {(analytics.reconciliationIssues ?? 0) > 0 && (
            <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[10px] font-bold text-amber-500">
              Wallet reconciliation needed: {analytics.reconciliationIssues} approved appeal(s) do not match a linked credit row.
            </p>
          )}
        </Card>
      )}

      <Card className="p-5">
        <div className="flex justify-between items-center gap-3 mb-4">
          <div>
            <p className="text-sm font-bold text-cream">Penalty review queue</p>
            <p className="text-[11px] text-muted mt-1">Original PENALTY ledger rows are preserved. Approvals post ADJUSTMENT credits (full or partial).</p>
          </div>
        </div>
        {loading ? <Skeleton className="h-28" /> : !(data?.pendingWaivers ?? []).length ? (
          <Empty icon="◷" title="No pending penalty reviews" desc="Employee appeals will appear here." />
        ) : (
          <div className="grid gap-3">
            {data!.pendingWaivers.map(w => (
              <div key={w.id} className="rounded-2xl border border-white/[0.06] bg-white/[0.04]/50 p-4 text-[11px] flex flex-col md:flex-row md:items-center gap-3">
                <EmployeeAvatar userId={w.requesterUserId} name={w.requesterName} imageUrl={w.requesterProfileImageUrl} size="sm" />
                <div className="flex-1 min-w-0">
                  <p className="text-cream font-bold">{w.requesterName} · {w.employeeId}</p>
                  <p className="text-muted-hi mt-1">{w.reason}</p>
                  <p className="text-muted mt-1">
                    {w.penaltyKind === 'NO_CHECKOUT'
                      ? 'চেক-আউট না করার জরিমানা'
                      : w.penaltyKind === 'EARLY_LEAVE'
                        ? `আগে চেক-আউট${w.penaltyMinutes ? ` · ${w.penaltyMinutes} মিনিট আগে` : ''}`
                        : `দেরিতে চেক-ইন · ${w.penaltyMinutes ?? w.lateMinutes} মিনিট দেরি`}
                    {' · '}{w.requestType?.replace(/_/g, ' ').toLowerCase() || 'appeal'} · asked {money(w.requestedReductionAmount ?? w.originalPenaltyAmount)} of {money(w.originalPenaltyAmount)}
                    {w.hasAttachment ? ' · 📎 attachment' : ''} · {w.createdAt.slice(0, 10)}
                  </p>
                  {(w.reviewContext?.exception || w.reviewContext?.leave) && (
                    <div className="mt-2 space-y-1 rounded-lg border border-blue-500/25 bg-blue-500/[0.07] px-2.5 py-2 text-[10px]">
                      {w.reviewContext.exception && (
                        <p className="text-blue-300">
                          অনুমতি: {w.reviewContext.exception.status} · {w.reviewContext.exception.scope.replace(/_/g, ' ').toLowerCase()} · {w.reviewContext.exception.reason}
                        </p>
                      )}
                      {w.reviewContext.leave && (
                        <p className="text-blue-300">
                          ছুটি: {w.reviewContext.leave.status} · {w.reviewContext.leave.kind.replace(/_/g, ' ').toLowerCase()} · {w.reviewContext.leave.reason}
                        </p>
                      )}
                    </div>
                  )}
                  {w.attachmentUrl && (
                    <a href={w.attachmentUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex font-bold text-blue-400">
                      Open submitted evidence ↗
                    </a>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button size="xs" variant="secondary" disabled={!canReview} onClick={() => startPenaltyReview(w, 'REJECT')}>Reject</Button>
                  <Button size="xs" variant="gold" disabled={!canReview} onClick={() => startPenaltyReview(w, 'APPROVE')}>Approve</Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {!canReview && <p className="mt-3 text-[11px] text-amber-600">Only Admin or Super Admin can review penalty appeals.</p>}
      </Card>

      {canReview && (
        <Card className="p-5">
          <div className="mb-4">
            <p className="text-sm font-bold text-cream">Recent penalty appeal decisions</p>
            <p className="mt-1 text-[11px] text-muted">Reviewer, rationale, wallet credit, and final penalty remain visible after resolution.</p>
          </div>
          {loading ? <Skeleton className="h-28" /> : !(data?.recentWaiverDecisions ?? []).length ? (
            <Empty icon="✓" title="No resolved penalty appeals yet" desc="Approved and rejected decisions will remain here for audit." />
          ) : (
            <div className="space-y-2">
              {data!.recentWaiverDecisions.map(row => (
                <div key={row.id} className="rounded-2xl border border-white/[0.06] bg-white/[0.04]/50 p-4 text-[11px]">
                  <div className="flex items-start gap-3">
                    <EmployeeAvatar userId={row.requesterUserId} name={row.requesterName} imageUrl={row.requesterProfileImageUrl} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-bold text-cream">{row.requesterName} · {row.employeeId}</p>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${row.status === 'REJECTED' || row.status === 'CANCELLED' ? 'tone-red' : 'tone-green'}`}>
                          {row.status.replace(/_/g, ' ')}
                        </span>
                      </div>
                      <p className="mt-1 text-muted">
                        {row.penaltyKind.replace(/_/g, ' ').toLowerCase()} · {new Date(row.attendanceDate).toLocaleDateString()} · original {money(row.originalPenaltyAmount)} · credited {money(row.approvedReductionAmount ?? 0)} · final {money(row.finalAppliedPenalty)}
                      </p>
                      <p className="mt-1 text-muted-hi">Staff explanation: {row.reason}</p>
                      <p className="mt-1 text-muted-hi">
                        {row.status === 'REJECTED'
                          ? `Rejection reason: ${row.adminNote || 'Legacy rejection reason not recorded'}`
                          : row.status === 'CANCELLED'
                            ? 'Cancelled by requester'
                            : row.adminNote
                              ? `Approval note: ${row.adminNote}`
                              : 'Approved — no additional note'}
                      </p>
                      <p className="mt-1 text-muted">Reviewed by {row.reviewerName || 'legacy / unknown reviewer'}{row.reviewedAt ? ` · ${new Date(row.reviewedAt).toLocaleString()}` : ''}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {row.reversalLedgerEntryId && row.refundReconciled && <span className="rounded-full border border-emerald-500/25 px-2 py-0.5 text-[10px] text-emerald-500">Wallet credit verified · {money(row.refundAmount)}</span>}
                        {!row.refundReconciled && <span className="rounded-full border border-amber-500/30 px-2 py-0.5 text-[10px] font-bold text-amber-500">Reconciliation needed · {row.refundIssue}</span>}
                        {row.attachmentUrl && <a href={row.attachmentUrl} target="_blank" rel="noreferrer" className="rounded-full border border-blue-500/25 px-2 py-0.5 text-[10px] text-blue-400">View evidence</a>}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <div className="grid lg:grid-cols-[1.5fr_1fr] gap-4">
        <Card className="p-5">
          <p className="text-sm font-bold text-cream mb-4">Today attendance log</p>
          {loading ? <Skeleton className="h-40" /> : !(data?.records ?? []).length ? (
            <Empty
              icon="◇"
              title="No check-ins yet"
              desc="Employees will appear here after tapping Start Work."
              action={<Link href="/portal"><Button variant="gold" size="sm">My desk</Button></Link>}
            />
          ) : (
            <>
            <div className="hidden overflow-x-auto min-w-0 max-w-full max-h-[420px] md:block">
              <table className="w-full min-w-[760px] text-left text-[11px]">
                <thead className="sticky top-0 z-[1] bg-card/88 backdrop-blur-sm border-b border-white/[0.06] text-muted text-xs uppercase tracking-wider">
                  <tr>
                    <th className="py-3 pr-3 font-medium">Employee</th>
                    {data?.scopeAllBusinesses && <th className="py-3 pr-3 font-medium">Business</th>}
                    <th className="py-3 pr-3 font-medium">Check in</th>
                    <th className="py-3 pr-3 font-medium">Check out</th>
                    <th className="py-3 pr-3 text-right font-medium">Worked</th>
                    <th className="py-3 pr-3 text-right font-medium">Late</th>
                    <th className="py-3 text-right font-medium">Penalty</th>
                    <th className="py-3 text-right font-medium">Trust</th>
                    <th className="py-3 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {data!.records.map(r => (
                    <tr key={r.id} className="transition-colors hover:bg-white/[0.04]/80">
                      <td className="py-3 pr-3">
                        <div className="flex items-center gap-2">
                          <EmployeeAvatar userId={r.userId} name={r.employeeName} imageUrl={r.profileImageUrl} size="sm" />
                          <span>
                            <span className="text-cream font-medium">{r.employeeName}</span>
                            <span className="block text-muted font-mono text-[10px]">{r.employeeId}</span>
                          </span>
                        </div>
                      </td>
                      {data?.scopeAllBusinesses && (
                        <td className="py-3 pr-3 text-muted">{r.businessId?.replace(/_/g, ' ') || '—'}</td>
                      )}
                      <td className="py-3 pr-3 font-mono text-cream">{time(r.checkInAt)}</td>
                      <td className="py-3 pr-3 font-mono text-cream">{r.checkOutAt ? time(r.checkOutAt) : '--'}</td>
                      <td className="py-3 pr-3 text-right font-mono text-cream">{duration(r.totalWorkMinutes)}</td>
                      <td className={`py-3 pr-3 text-right font-mono font-medium ${r.lateMinutes ? 'text-red-600' : 'text-emerald-600'}`}>{duration(r.lateMinutes)}</td>
                      <td className="py-3 text-right font-mono text-red-600">{money(r.penaltyAmount)}</td>
                      <td className="py-3 text-right">
                        <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full ${r.trustStatus === 'TRUSTED' ? 'tone-green' : r.trustStatus === 'WARNING' ? 'tone-amber' : 'tone-red'}`} title={r.suspiciousReasons.join(', ')}>
                          {r.trustStatus.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="py-3 text-right">
                        <div className="flex justify-end gap-1 flex-wrap">
                          {canResetAttendance ? (
                            <Button
                              size="xs"
                              variant="secondary"
                              disabled={resettingRecordId === r.id}
                              onClick={() => void resetAttendance(r.id, r.employeeName)}
                            >
                              {resettingRecordId === r.id ? '…' : 'Reset'}
                            </Button>
                          ) : null}
                          <Button size="xs" variant="secondary" disabled={role !== 'SUPER_ADMIN' || r.verificationRequired || r.selfieCount > 0} onClick={() => void requestVerification(r.id)}>
                            {r.selfieCount > 0 ? 'Verified' : r.verificationRequired ? 'Requested' : 'Selfie'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile Cards */}
            <motion.div
              className="space-y-3 md:hidden"
              variants={_stagger} initial="hidden" animate="show"
            >
              {data!.records.slice(0, 60).map(r => (
                <motion.div key={r.id} variants={_fadeUp}>
                  <Card interactive className="p-4 text-[11px]">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <EmployeeAvatar userId={r.userId} name={r.employeeName} imageUrl={r.profileImageUrl} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-cream">{r.employeeName}</p>
                          <p className="font-mono text-muted text-[10px]">{r.employeeId}</p>
                        </div>
                      </div>
                      <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full ${r.trustStatus === 'TRUSTED' ? 'tone-green' : r.trustStatus === 'WARNING' ? 'tone-amber' : 'tone-red'}`}>
                        {r.trustStatus.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                      <div className="rounded-xl bg-white/[0.04] py-2 px-1">
                        <p className="font-mono text-cream font-medium">{time(r.checkInAt)}</p>
                        <p className="text-[10px] text-muted">In</p>
                      </div>
                      <div className="rounded-xl bg-white/[0.04] py-2 px-1">
                        <p className="font-mono text-cream font-medium">{r.checkOutAt ? time(r.checkOutAt) : '--'}</p>
                        <p className="text-[10px] text-muted">Out</p>
                      </div>
                      <div className={`rounded-xl py-2 px-1 ${r.lateMinutes ? 'bg-red-500/10' : 'bg-emerald-500/10'}`}>
                        <p className={`font-mono font-medium ${r.lateMinutes ? 'text-red-600' : 'text-emerald-600'}`}>{duration(r.lateMinutes)}</p>
                        <p className="text-[10px] text-muted">Late</p>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2 pt-2 border-t border-white/[0.04]">
                      <span className="text-muted">Worked {duration(r.totalWorkMinutes)}</span>
                      <span className="font-mono font-medium text-red-600">{money(r.penaltyAmount)}</span>
                    </div>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
            </>
          )}
        </Card>

        <Card className="p-5">
          <p className="text-sm font-bold text-cream mb-4">Punctuality ranking</p>
          {loading ? <Skeleton className="h-40" /> : !(data?.ranking ?? []).length ? (
            <p className="text-[11px] text-muted">No linked employees for this business.</p>
          ) : (
            <div className="space-y-2 max-h-[420px] overflow-y-auto [-webkit-overflow-scrolling:touch] overscroll-contain">
              {data!.ranking.slice(0, 20).map((r, i) => (
                <div key={`${r.employeeId}-${i}`} className="rounded-2xl border border-white/[0.06] bg-white/[0.04]/50 p-3 text-[11px] hover:bg-white/[0.04] transition-colors">
                  <div className="flex justify-between gap-2 items-center">
                    <span className="flex items-center gap-2 min-w-0">
                      <EmployeeAvatar userId={r.userId} name={r.name} imageUrl={r.profileImageUrl} size="sm" />
                      <span className="text-cream font-semibold truncate">{i + 1}. {r.name}</span>
                    </span>
                    <span className="font-mono text-gold font-bold">{r.punctualityScore}%</span>
                  </div>
                  <p className="mt-1 text-muted">{r.presentDays} days · {r.lateCount} late · avg {r.averageWorkLabel} · penalty {money(r.penaltyTotal)}</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className="p-5">
        <p className="text-sm font-bold text-cream mb-4">Absent employees today</p>
        {loading ? <Skeleton className="h-20" /> : !(data?.absentEmployees ?? []).length ? (
          <p className="text-[11px] text-emerald-600 font-medium">No absences among linked employees today.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data!.absentEmployees.map(e => (
              <span key={`${e.employeeId}-${e.name}`} className="inline-flex items-center gap-2 rounded-full border tone-red px-3 py-1.5 text-[11px] font-medium">
                <EmployeeAvatar userId={e.id} name={e.name} imageUrl={e.profileImageUrl} size="xs" />
                {e.name} · {e.employeeId || 'unlinked'}
              </span>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <p className="text-sm font-bold text-cream mb-4">Pending face verification reviews</p>
        {loading ? <Skeleton className="h-20" /> : !pendingSelfieReviews.length ? (
          <p className="text-[11px] text-muted">No submitted verification photos awaiting review.</p>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {pendingSelfieReviews.map(log => (
              <div key={log.id} className="rounded-2xl border border-amber-500/35 bg-amber-500/10 p-3 text-[11px]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <VerificationPhoto
                  src={log.imageUrl || log.imageDataUrl}
                  missing={log.imageMissing}
                  employeeId={log.employeeId}
                />
                <div className="mt-2 flex justify-between gap-2 flex-wrap">
                  <span className="font-mono text-muted-hi">{log.employeeId}</span>
                  <span className="text-muted">{new Date(log.capturedAt).toLocaleString()}</span>
                </div>
                {data?.scopeAllBusinesses && (
                  <p className="mt-1 text-[10px] text-amber-600">{log.businessId.replace(/_/g, ' ')}</p>
                )}
                {role === 'SUPER_ADMIN' && (
                  <div className="mt-3 flex gap-2">
                    <Button size="xs" variant="secondary" onClick={() => void reviewSelfie(log.id, log.businessId, 'REJECT')}>Reject</Button>
                    <Button size="xs" variant="gold" onClick={() => void reviewSelfie(log.id, log.businessId, 'APPROVE')}>Approve</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <p className="text-sm font-bold text-cream mb-4">Selfie verification logs</p>
        {loading ? <Skeleton className="h-20" /> : !(data?.selfieLogs ?? []).length ? (
          <p className="text-[11px] text-muted">No selfie verification logs this month.</p>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {data!.selfieLogs.slice(0, 12).map(log => (
              <div key={log.id} className="rounded-2xl border border-white/[0.06] bg-white/[0.04]/30 p-3 text-[11px]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <VerificationPhoto
                  src={log.imageUrl || log.imageDataUrl}
                  missing={log.imageMissing}
                  employeeId={log.employeeId}
                />
                <div className="mt-2 flex justify-between gap-2">
                  <span className="font-mono text-muted">{log.employeeId}</span>
                  <span className="text-muted">{new Date(log.capturedAt).toLocaleString()}</span>
                </div>
                {log.reviewedAt ? (
                  <p className="mt-1 text-emerald-600 font-medium">Reviewed {new Date(log.reviewedAt).toLocaleString()}</p>
                ) : (
                  <p className="mt-1 text-amber-600 font-medium">Awaiting review</p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {review && (
        <MobileModalPortal open zIndex={90} onBackdropClick={() => setReview(null)}>
          <Card className="mobile-modal-shell w-full max-w-md border-gold/20 sm:rounded-2xl">
            <div className="mobile-modal-header p-5 pb-3">
              <p className="text-sm font-bold text-cream">{review.action === 'APPROVE' ? 'Approve penalty reduction' : 'Reject penalty appeal'}</p>
              <p className="text-xs text-muted mt-1">
                {review.employeeId} · original penalty {money(review.originalPenalty)} · requested reduction {money(review.requestedAmount)}
              </p>
            </div>
            <div className="mobile-modal-body space-y-3 px-5">
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.04] p-3 text-[11px]">
                <p className="font-bold text-cream">Staff explanation</p>
                <p className="mt-1 text-muted-hi">{review.reason}</p>
                <p className="mt-2 text-muted">{review.penaltyKind?.replace(/_/g, ' ').toLowerCase()} · submitted {new Date(review.createdAt).toLocaleString()}</p>
                {review.attachmentUrl && <a href={review.attachmentUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex font-bold text-blue-400">Open submitted evidence ↗</a>}
              </div>
              {(review.reviewContext?.exception || review.reviewContext?.leave) && (
                <div className="rounded-xl border border-blue-500/25 bg-blue-500/[0.07] p-3 text-[11px] text-blue-300">
                  {review.reviewContext.exception && <p>Permission: {review.reviewContext.exception.status} · {review.reviewContext.exception.scope.replace(/_/g, ' ')} · {review.reviewContext.exception.reason}</p>}
                  {review.reviewContext.leave && <p>Leave: {review.reviewContext.leave.status} · {review.reviewContext.leave.kind.replace(/_/g, ' ')} · {review.reviewContext.leave.reason}</p>}
                </div>
              )}
              {review.action === 'APPROVE' && (
                (() => {
                  const approved = Number(review.amount)
                  const valid = Number.isFinite(approved) && approved > 0 && approved <= review.requestedAmount && approved <= review.originalPenalty
                  const remaining = valid ? Math.max(0, review.originalPenalty - approved) : review.originalPenalty
                  const partial = valid && remaining > 0
                  const halfPenalty = Math.min(review.requestedAmount, Math.max(1, Math.round((review.originalPenalty * 0.5) * 100) / 100))
                  return (
                    <div className="space-y-3 rounded-2xl border border-gold/20 bg-gold/[0.05] p-3 text-[11px]">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-xl border border-white/[0.06] bg-card/70 p-2.5">
                          <p className="text-muted">Original penalty</p>
                          <p className="mt-1 font-mono text-sm font-black text-cream">{money(review.originalPenalty)}</p>
                        </div>
                        <div className="rounded-xl border border-white/[0.06] bg-card/70 p-2.5">
                          <p className="text-muted">Staff requested</p>
                          <p className="mt-1 font-mono text-sm font-black text-cream">{money(review.requestedAmount)}</p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button size="xs" variant={approved === review.requestedAmount ? 'gold' : 'secondary'} onClick={() => setReview(r => r ? { ...r, amount: String(review.requestedAmount) } : r)}>
                          Full requested · {money(review.requestedAmount)}
                        </Button>
                        <Button size="xs" variant={approved === halfPenalty && halfPenalty !== review.requestedAmount ? 'gold' : 'secondary'} onClick={() => setReview(r => r ? { ...r, amount: String(halfPenalty) } : r)}>
                          Half penalty · {money(halfPenalty)}
                        </Button>
                      </div>
                      <label className="block space-y-1">
                        <span className="font-bold text-muted">Exact wallet credit</span>
                        <input value={review.amount} onChange={e => setReview(r => r ? { ...r, amount: e.target.value } : r)} type="number" inputMode="decimal" min="0.01" max={review.requestedAmount} step="0.01" className="w-full rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2.5 text-cream font-mono focus:outline-none focus:ring-2 focus:ring-gold/20" />
                      </label>
                      <div className={`rounded-xl border p-2.5 ${valid ? partial ? 'border-amber-500/30 bg-amber-500/10' : 'border-emerald-500/30 bg-emerald-500/10' : 'border-red-500/30 bg-red-500/10'}`}>
                        {valid ? (
                          <>
                            <p className={`font-black ${partial ? 'text-amber-300' : 'text-emerald-300'}`}>{partial ? 'Partial approval' : 'Full approval'}</p>
                            <p className="mt-1 text-muted-hi">Wallet credit {money(approved)} · Remaining penalty {money(remaining)}</p>
                            <p className="mt-1 text-muted">Staff notification and SMS will show this exact result.</p>
                          </>
                        ) : (
                          <p className="font-bold text-red-300">Enter up to the staff-requested maximum: {money(review.requestedAmount)}.</p>
                        )}
                      </div>
                    </div>
                  )
                })()
              )}
              <label className="block space-y-1 text-[11px]">
                <span className="text-muted">{review.action === 'REJECT' ? 'Rejection reason (required)' : 'Approval note (optional)'}</span>
                <textarea required={review.action === 'REJECT'} minLength={review.action === 'REJECT' ? 5 : undefined} value={review.note} onChange={e => setReview(r => r ? { ...r, note: e.target.value } : r)} rows={3} placeholder={review.action === 'APPROVE' ? 'Add a note only if useful for the staff member' : 'Explain clearly why this appeal is being rejected'} className="w-full rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2.5 text-cream focus:outline-none focus:ring-2 focus:ring-gold/20" />
              </label>
            </div>
            <div className="mobile-modal-footer px-5 pt-3">
              <div className="flex justify-end gap-2">
                <Button size="xs" variant="secondary" onClick={() => setReview(null)}>Cancel</Button>
                <Button size="xs" variant={review.action === 'APPROVE' ? 'gold' : 'danger'} disabled={reviewBusy || (review.action === 'REJECT' && review.note.trim().length < 5) || (review.action === 'APPROVE' && (!Number.isFinite(Number(review.amount)) || Number(review.amount) <= 0 || Number(review.amount) > review.requestedAmount || Number(review.amount) > review.originalPenalty))} onClick={() => void submitReview()}>
                  {reviewBusy
                    ? 'Processing…'
                    : review.action === 'APPROVE'
                      ? `${Number(review.amount) < review.originalPenalty ? 'Approve partial' : 'Approve full'} · credit ${money(Number(review.amount || 0))}`
                      : 'Reject'}
                </Button>
              </div>
            </div>
          </Card>
        </MobileModalPortal>
      )}
      </PageEnter>
    </FinancePageChrome>
  )
}

function VerificationPhoto({
  src,
  missing,
  employeeId,
}: {
  src: string | null | undefined
  missing?: boolean
  employeeId: string
}) {
  const [broken, setBroken] = useState(false)
  const showFallback =
    missing || broken || !src || (!src.startsWith('http') && !src.startsWith('data:image/'))
  if (showFallback) {
    return (
      <div className="flex h-36 flex-col items-center justify-center gap-2 rounded-xl border tone-amber px-3 text-center text-[10px]">
        <span className="font-black uppercase tracking-wide">Photo unavailable</span>
        <span className="text-muted">Storage ref missing or expired for {employeeId}. Ask employee to re-verify if needed.</span>
      </div>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt="Verification selfie"
      className="h-36 w-full rounded-xl object-cover bg-white/[0.06]"
      onError={() => setBroken(true)}
    />
  )
}

function money(value: unknown) {
  return `৳ ${Number(value || 0).toLocaleString('en-BD')}`
}

function AnalyticsStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.04]/50 px-3 py-2.5">
      <p className="text-[9px] uppercase tracking-wider text-muted font-medium">{label}</p>
      <p className={`mt-0.5 font-mono font-bold ${tone || 'text-cream'}`}>{value}</p>
    </div>
  )
}

function duration(minutes: number) {
  const h = Math.floor(Number(minutes || 0) / 60)
  const m = Number(minutes || 0) % 60
  if (!h) return `${m}m`
  return `${h}h ${m}m`
}

function time(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
