'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import { useHRDashboard } from '@/hooks/useHr'
import Link from 'next/link'
import { Card, KpiCard, Skeleton, Empty, Button, KPI_AUTO_GRID } from '@/components/ui'
import { PageEnter } from '@/components/layout/AgentAccess'
import { useActor } from '@/contexts/ActorContext'
import { can } from '@/lib/roles'
import { useBusiness } from '@/contexts/BusinessContext'
const _stagger = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } }
const _fadeUp = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: [0.22, 1, 0.36, 1] } } }
import type { PayrollWallet, WalletRequestDto, WalletSummaryResponse } from '@/types/payroll-wallet'
import { downloadBlob, payrollWalletsToCsv, payrollWalletsToWorkbook } from '@/lib/export-payroll-wallet'
import toast from 'react-hot-toast'
import { safeFetchJsonWithToast } from '@/lib/safe-fetch'
import { unwrapApiData } from '@/lib/safe-api-response'

type MealProfileUser = {
  id: string
  name: string
  phone: string | null
  employeeIdGas: string | null
}

type MealProfileRow = {
  user: MealProfileUser
  profile: { id: string; enabled: boolean; amountBdt: number | string } | null
}

type MealProfileRowState = {
  userId: string
  name: string
  phone: string | null
  employeeId: string
  enabled: boolean
  amountBdt: string
  saving: boolean
}

const PAYROLL_COMPENSATION_TYPES = [
  { value: 'SALARY_ACCRUAL', label: '💰 Salary credit (manual)', kind: 'credit' as const },
  { value: 'COMMISSION', label: 'Commission earned', kind: 'credit' as const },
  { value: 'EID_BONUS', label: 'Eid bonus', kind: 'credit' as const },
  { value: 'PERFORMANCE_BONUS', label: 'Performance bonus', kind: 'credit' as const },
  { value: 'OVERTIME', label: 'Overtime payment', kind: 'credit' as const },
  { value: 'REIMBURSEMENT', label: 'Reimbursement', kind: 'credit' as const },
  { value: 'MEAL_DEDUCTION', label: 'Meal deduction (debit)', kind: 'debit' as const },
  { value: 'PENALTY', label: 'Penalty (debit)', kind: 'debit' as const },
  { value: 'ADJUSTMENT', label: 'Manual adjustment', kind: 'adjust' as const },
] as const

export default function PayrollPage() {
  const { role } = useActor()
  const { business } = useBusiness()
  const { data, loading } = useHRDashboard()
  const k = data?.kpis
  const roll = data?.employees_roll ?? []

  const [walletData, setWalletData] = useState<WalletSummaryResponse | null>(null)
  const [compWallets, setCompWallets] = useState<PayrollWallet[]>([])
  const [orphanLedgerCount, setOrphanLedgerCount] = useState(0)
  const [walletLoading, setWalletLoading] = useState(false)
  const [walletError, setWalletError] = useState<string | null>(null)
  const [automation, setAutomation] = useState<{ enabled: boolean; dayOfMonth: number; timezone: string } | null>(null)
  const [preview, setPreview] = useState<{ totalPreviewSalary: number; alreadyAccruedCount: number; employees: Array<{ employeeId: string; name: string; salary: number; alreadyAccrued: boolean }> } | null>(null)
  const [history, setHistory] = useState<Array<{ id: string; periodYm: string; status: string; trigger: string; createdCount: number; skippedCount: number; createdAt: string; error?: string | null }>>([])
  const [review, setReview] = useState<{ id: string; action: 'APPROVE' | 'REJECT'; requestedAmount: number; approvedAmount: string } | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [ledgerTypeFilter, setLedgerTypeFilter] = useState('ALL')
  const [employeeFilter, setEmployeeFilter] = useState('')
  const [compForm, setCompForm] = useState({ employeeId: '', type: 'EID_BONUS', amount: '', note: '', date: new Date().toISOString().slice(0, 10) })
  const [compBusy, setCompBusy] = useState(false)
  const [mealRows, setMealRows] = useState<MealProfileRowState[]>([])
  const [mealLoading, setMealLoading] = useState(false)
  const walletRequestId = useRef(0)

  const showApprovals = can(role, 'advanceApprove')

  const loadWallets = useCallback(async (fresh = false) => {
    if (!showApprovals) return
    const requestId = ++walletRequestId.current
    setWalletLoading(true)
    setWalletError(null)
    const qs = fresh ? `&refresh=${Date.now()}` : ''
    try {
      const [fullRes, rosterRes] = await Promise.all([
        safeFetchJsonWithToast<WalletSummaryResponse>(
          `/api/payroll/wallet/summary?business_id=${business.id}${qs}`,
          { cache: 'no-store', toastOnError: false },
        ),
        safeFetchJsonWithToast<WalletSummaryResponse>(
          `/api/payroll/wallet/summary?business_id=${business.id}&roster_only=true${qs}`,
          { cache: 'no-store', toastOnError: false },
        ),
      ])
      if (!fullRes.ok) throw new Error(fullRes.error.message)
      if (requestId !== walletRequestId.current) return
      const full = unwrapApiData<WalletSummaryResponse>(fullRes.data as Record<string, unknown>)
      setWalletData(full)
      if (rosterRes.ok) {
        const roster = unwrapApiData<WalletSummaryResponse>(rosterRes.data as Record<string, unknown>)
        setCompWallets(roster.wallets)
        setOrphanLedgerCount(roster.orphanLedgerEntryCount ?? 0)
      } else {
        setCompWallets(full.wallets)
        setOrphanLedgerCount(0)
      }
    } catch (e) {
      if (requestId !== walletRequestId.current) return
      const message = (e as Error).message || 'Could not load employee wallets'
      setWalletError(message)
      toast.error(message)
    } finally {
      if (requestId === walletRequestId.current) setWalletLoading(false)
    }
  }, [business.id, showApprovals])

  useEffect(() => {
    void loadWallets()
  }, [loadWallets])

  const loadAutomation = useCallback(async () => {
    if (!showApprovals) return
    const [settingRes, previewRes, historyRes] = await Promise.all([
      safeFetchJsonWithToast<Record<string, unknown>>('/api/payroll/wallet/automation', { cache: 'no-store', toastOnError: false }),
      safeFetchJsonWithToast<Record<string, unknown>>(`/api/payroll/wallet/accruals/preview?business_id=${business.id}`, { cache: 'no-store', toastOnError: false }),
      safeFetchJsonWithToast<Record<string, unknown>>(`/api/payroll/wallet/accruals/history?business_id=${business.id}`, { cache: 'no-store', toastOnError: false }),
    ])
    if (settingRes.ok) {
      const s = unwrapApiData<{ setting: { enabled: boolean; dayOfMonth: number; timezone: string } }>(settingRes.data as Record<string, unknown>)
      setAutomation(s.setting)
    }
    if (previewRes.ok) setPreview(unwrapApiData(previewRes.data as Record<string, unknown>) as NonNullable<typeof preview>)
    if (historyRes.ok) {
      const h = unwrapApiData<{ runs: typeof history }>(historyRes.data as Record<string, unknown>)
      setHistory(h.runs ?? [])
    }
  }, [business.id, showApprovals])

  useEffect(() => {
    void loadAutomation()
  }, [loadAutomation])

  const loadMealProfiles = useCallback(async () => {
    if (!showApprovals) return
    setMealLoading(true)
    try {
      const result = await safeFetchJsonWithToast<{ rows?: MealProfileRow[] }>(
        `/api/payroll/meal-allowance/profiles?business_id=${encodeURIComponent(business.id)}`,
        { cache: 'no-store', toastOnError: false },
      )
      if (!result.ok) throw new Error(result.error.message)
      const payload = unwrapApiData<{ rows?: MealProfileRow[] }>(result.data as Record<string, unknown>)
      setMealRows(
        (payload.rows ?? []).map(row => ({
          userId: row.user.id,
          name: row.user.name,
          phone: row.user.phone,
          employeeId: row.user.employeeIdGas || '',
          enabled: row.profile?.enabled ?? false,
          amountBdt: row.profile ? String(Number(row.profile.amountBdt) || '') : '',
          saving: false,
        })),
      )
    } catch (e) {
      toast.error((e as Error).message || 'Could not load meal allowance settings')
      setMealRows([])
    } finally {
      setMealLoading(false)
    }
  }, [business.id, showApprovals])

  useEffect(() => {
    void loadMealProfiles()
  }, [loadMealProfiles])

  async function saveMealProfile(row: MealProfileRowState) {
    if (row.saving) return
    const amount = Number(row.amountBdt)
    if (row.enabled && (!Number.isFinite(amount) || amount <= 0)) {
      toast.error('Enter a valid amount (BDT) before enabling')
      return
    }
    setMealRows(prev => prev.map(r => (r.userId === row.userId ? { ...r, saving: true } : r)))
    try {
      const result = await safeFetchJsonWithToast<{ profile?: { enabled: boolean; amountBdt: number | string } }>(
        '/api/payroll/meal-allowance/profiles',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            business_id: business.id,
            userId: row.userId,
            employeeId: row.employeeId,
            enabled: row.enabled,
            amountBdt: row.enabled ? amount : 0,
          }),
        },
      )
      if (!result.ok) throw new Error(result.error.message)
      const saved = unwrapApiData<{ profile?: { enabled: boolean; amountBdt: number | string } }>(
        result.data as Record<string, unknown>,
      )
      toast.success(`Meal allowance saved for ${row.name}`)
      setMealRows(prev =>
        prev.map(r =>
          r.userId === row.userId
            ? {
                ...r,
                enabled: saved.profile?.enabled ?? row.enabled,
                amountBdt: saved.profile ? String(Number(saved.profile.amountBdt) || '') : row.amountBdt,
                saving: false,
              }
            : r,
        ),
      )
    } catch (e) {
      toast.error((e as Error).message || 'Could not save meal allowance')
      setMealRows(prev => prev.map(r => (r.userId === row.userId ? { ...r, saving: false } : r)))
    }
  }

  async function submitReview() {
    if (!review || reviewBusy) return
    const approvedAmount = review.action === 'APPROVE'
      ? Number(review.approvedAmount || review.requestedAmount)
      : undefined
    if (review.action === 'APPROVE' && (!approvedAmount || approvedAmount <= 0)) {
      toast.error('Enter a valid approved amount')
      return
    }
    setReviewBusy(true)
    try {
      const result = await safeFetchJsonWithToast(`/api/payroll/wallet/requests/${review.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: review.action, approvedAmount, note: '' }),
      })
      if (!result.ok) return
      toast.success(review.action === 'APPROVE' ? 'Approved · wallet ledger updated' : 'Rejected')
      setReview(null)
      void loadWallets(true)
    } finally {
      setReviewBusy(false)
    }
  }

  async function runAccrual() {
    const result = await safeFetchJsonWithToast('/api/payroll/wallet/accruals/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_id: business.id }),
    })
    if (!result.ok) return
    toast.success('Monthly salary accrual checked')
    void loadWallets(true)
    void loadAutomation()
  }

  async function toggleAutomation(enabled: boolean) {
    const result = await safeFetchJsonWithToast<{ setting: NonNullable<typeof automation> }>('/api/payroll/wallet/automation', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    if (!result.ok) return
    setAutomation(result.data.setting)
    toast.success(enabled ? 'Payroll automation enabled' : 'Payroll automation disabled')
  }

  async function exportPdf() {
    const wallets = walletData?.wallets ?? []
    if (!wallets.length) return
    const [{ pdf }, { BusinessPayrollSummaryDocument }] = await Promise.all([
      import('@react-pdf/renderer'),
      import('@/components/pdf/PayrollWalletDocuments'),
    ])
    const blob = await pdf(
      <BusinessPayrollSummaryDocument
        wallets={wallets}
        businessName={business.name}
        generatedAt={new Date().toISOString().slice(0, 10)}
      />,
    ).toBlob()
    downloadBlob(`payroll-wallet-${business.id}.pdf`, blob)
  }

  async function exportXlsx() {
    const wallets = walletData?.wallets ?? []
    if (!wallets.length) return
    const buf = await payrollWalletsToWorkbook(wallets)
    downloadBlob(`payroll-wallet-${business.id}.xlsx`, new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  }

  function exportCsv() {
    const wallets = walletData?.wallets ?? []
    if (!wallets.length) return
    downloadBlob(`payroll-wallet-${business.id}.csv`, new Blob([payrollWalletsToCsv(wallets)], { type: 'text/csv;charset=utf-8' }))
  }

  async function submitCompensation(e: React.FormEvent) {
    e.preventDefault()
    const amount = Number(compForm.amount)
    if (!compForm.employeeId || !Number.isFinite(amount) || amount === 0) {
      toast.error('Employee and non-zero amount required')
      return
    }
    if (compForm.type !== 'ADJUSTMENT' && amount <= 0) {
      toast.error('Amount must be positive for this entry type')
      return
    }
    setCompBusy(true)
    try {
      const result = await safeFetchJsonWithToast('/api/payroll/wallet/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          employee_id: compForm.employeeId,
          type: compForm.type,
          amount,
          note: compForm.note,
          date: compForm.date,
        }),
      })
      if (!result.ok) throw new Error(result.error.message)
      toast.success('Compensation ledger entry posted')
      setCompForm(f => ({ ...f, amount: '', note: '' }))
      void loadWallets(true)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setCompBusy(false)
    }
  }

  const filteredWallets = (walletData?.wallets ?? []).filter(w => {
    const employeeNeedle = employeeFilter.trim().toLowerCase()
    const employeeOk = !employeeNeedle || w.employeeId.toLowerCase().includes(employeeNeedle) || w.name.toLowerCase().includes(employeeNeedle)
    const typeOk = ledgerTypeFilter === 'ALL' || w.latestEntries.some(e => e.type === ledgerTypeFilter)
    return employeeOk && typeOk
  })

  return (
    <FinancePageChrome
      title="Payroll"
      subtitle="Salary burden · advances · settlement health"
      actions={
        <div className="flex gap-2 flex-wrap justify-end">
          <Button size="xs" variant="gold" onClick={() => void runAccrual()}>Run accrual</Button>
          <Button size="xs" variant="secondary" disabled={!walletData?.wallets.length} onClick={() => void exportPdf()}>PDF</Button>
          <Button size="xs" variant="secondary" disabled={!walletData?.wallets.length} onClick={() => exportCsv()}>CSV</Button>
          <Button size="xs" variant="secondary" disabled={!walletData?.wallets.length} onClick={() => void exportXlsx()}>Excel</Button>
          <Link href="/employees"><Button size="xs" variant="secondary">Employees</Button></Link>
        </div>
      }
    >
      <PageEnter className="min-w-0 max-w-full space-y-5">
      {walletError && showApprovals && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{walletError}</span>
          <Button variant="ghost" size="xs" onClick={() => void loadWallets(true)}>Retry</Button>
        </div>
      )}

      <div className={KPI_AUTO_GRID}>
        <KpiCard label="Monthly salary budget" value={k?.total_monthly_salary ?? 0} valueKind="currency" loading={loading} />
        <KpiCard label="Company liability" value={walletData?.totals.companyLiability ?? 0} valueKind="currency" color="text-green-400" loading={walletLoading} />
        <KpiCard label="Commission totals" value={walletData?.totals.totalCommissions ?? 0} valueKind="currency" color="text-green-400" loading={walletLoading} />
        <KpiCard label="Bonus totals" value={walletData?.totals.totalBonuses ?? 0} valueKind="currency" color="text-gold-lt" loading={walletLoading} />
        <KpiCard label="Meal deductions" value={walletData?.totals.totalMealDeductions ?? 0} valueKind="currency" color="text-red-400" loading={walletLoading} />
        <KpiCard label="Unpaid balance" value={walletData?.totals.currentBalance ?? 0} valueKind="currency" loading={walletLoading} />
      </div>

      {showApprovals && (
        <Card className="p-5">
          <div className="flex justify-between gap-3 items-start flex-wrap mb-4">
            <div>
              <p className="text-sm font-bold text-slate-800">Compensation tools</p>
              <p className="text-[11px] text-slate-500 mt-1">Post salary credit, bonuses, commission, overtime, reimbursements, deductions, penalties, or adjustments into the unified wallet ledger.</p>
            </div>
          </div>
          <form onSubmit={submitCompensation} className="grid md:grid-cols-[1.2fr_1fr_1fr_1fr_1.5fr_auto] gap-2 text-[11px]">
            <select value={compForm.employeeId} onChange={e => setCompForm(f => ({ ...f, employeeId: e.target.value }))} className="rounded-xl border border-black/[0.06] bg-white px-3 py-2.5 text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20">
              <option value="">Select employee</option>
              {compWallets.map(w => <option key={`${w.businessId}:${w.employeeId}`} value={w.employeeId}>{w.name} · {w.employeeId}</option>)}
            </select>
            <select value={compForm.type} onChange={e => setCompForm(f => ({ ...f, type: e.target.value }))} className="rounded-xl border border-black/[0.06] bg-white px-3 py-2.5 text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20">
              {PAYROLL_COMPENSATION_TYPES.map(t => (
                <option key={t.value} value={t.value}>
                  {t.label}{t.kind === 'credit' ? ' · credit' : t.kind === 'debit' ? ' · debit' : ''}
                </option>
              ))}
            </select>
            <input value={compForm.amount} onChange={e => setCompForm(f => ({ ...f, amount: e.target.value }))} type="number" min={compForm.type === 'ADJUSTMENT' ? undefined : 1} step="1" placeholder={compForm.type === 'ADJUSTMENT' ? 'Amount (+/-)' : 'Amount'} className="rounded-xl border border-black/[0.06] bg-white px-3 py-2.5 text-slate-800 font-mono focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20" />
            <input value={compForm.date} onChange={e => setCompForm(f => ({ ...f, date: e.target.value }))} type="date" className="rounded-xl border border-black/[0.06] bg-white px-3 py-2.5 text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20" />
            <input value={compForm.note} onChange={e => setCompForm(f => ({ ...f, note: e.target.value }))} placeholder="Note" className="rounded-xl border border-black/[0.06] bg-white px-3 py-2.5 text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20" />
            <Button size="xs" variant="gold" type="submit" loading={compBusy}>Post</Button>
          </form>
          {orphanLedgerCount > 0 && (
            <p className="mt-3 text-[11px] text-amber-700 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
              {orphanLedgerCount} orphan ledger {orphanLedgerCount === 1 ? 'entry' : 'entries'} (not on roster / no linked user).{' '}
              <button
                type="button"
                className="text-[#E07A5F] underline font-medium"
                onClick={() => {
                  setLedgerTypeFilter('ALL')
                  setEmployeeFilter('')
                  document.getElementById('payroll-wallet-table')?.scrollIntoView({ behavior: 'smooth' })
                }}
              >
                Review in wallet table
              </button>
            </p>
          )}
        </Card>
      )}

      {showApprovals && (
        <Card className="p-5">
          <div className="flex justify-between gap-3 items-start flex-wrap">
            <div>
              <p className="text-sm font-bold text-slate-800">Monthly payroll automation</p>
              <p className="text-[11px] text-slate-500 mt-1">
                Runs on day {automation?.dayOfMonth ?? 10} · credits previous month salary (e.g. June 10 → May) · {automation?.timezone ?? 'Asia/Dhaka'}
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="xs" variant={automation?.enabled ? 'secondary' : 'gold'} onClick={() => void toggleAutomation(!automation?.enabled)}>
                {automation?.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button size="xs" variant="gold" onClick={() => void runAccrual()}>Run now</Button>
            </div>
          </div>
          <div className="grid md:grid-cols-3 gap-3 mt-4">
            <div className="rounded-2xl border border-black/[0.06] bg-slate-50/50 p-4">
              <p className="text-[9px] uppercase tracking-wider text-slate-500 font-bold">Monthly preview</p>
              <p className="font-mono text-emerald-600 text-lg font-bold mt-1">৳ {Number(preview?.totalPreviewSalary ?? 0).toLocaleString('en-BD')}</p>
              <p className="text-[10px] text-slate-500">{preview?.employees.length ?? 0} linked employees · {preview?.alreadyAccruedCount ?? 0} already accrued</p>
            </div>
            <div className="md:col-span-2 rounded-2xl border border-black/[0.06] bg-slate-50/50 p-4">
              <p className="text-[9px] uppercase tracking-wider text-slate-500 font-bold mb-2">Accrual history</p>
              {!history.length ? <p className="text-[11px] text-slate-400">No accrual runs yet.</p> : (
                <div className="grid gap-1 text-[11px] max-h-28 overflow-y-auto">
                  {history.slice(0, 6).map(run => (
                    <div key={run.id} className="flex justify-between gap-2 border-b border-black/[0.04] pb-1">
                      <span className="font-mono text-slate-500">{run.periodYm}</span>
                      <span className={run.status === 'SUCCESS' ? 'text-emerald-600 font-medium' : run.status === 'RUNNING' ? 'text-amber-600 font-medium' : 'text-red-600 font-medium'}>{run.status}</span>
                      <span className="text-slate-500">{run.trigger}</span>
                      <span className="font-mono text-[#E07A5F]">+{run.createdCount} / skip {run.skippedCount}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {showApprovals && (
        <Card className="p-5 border-amber-100">
          <div className="flex justify-between items-center gap-3 mb-3 flex-wrap">
            <p className="text-sm font-bold text-slate-800">Pending wallet requests</p>
            <Button size="xs" variant="secondary" type="button" onClick={() => void loadWallets()}>Refresh</Button>
          </div>
          {walletLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !(walletData?.pendingRequests ?? []).length ? (
            <Empty icon="◆" title="No pending wallet requests" desc="Advance and withdrawal requests will appear here." />
          ) : (
            <div className="overflow-x-auto space-y-2">
              {walletData!.pendingRequests.map(req => (
                <div key={req.id} className="flex flex-col sm:flex-row sm:items-center gap-3 border border-black/[0.06] rounded-2xl p-4 text-[11px] hover:bg-slate-50/50 transition-colors">
                  <div className="flex-1 min-w-0">
                    <p className="text-slate-800 font-semibold">{req.type.replace(/_/g, ' ')} · {req.employeeId}</p>
                    <p className="text-slate-500 mt-1">{req.reason.slice(0, 160)}{req.reason.length > 160 ? '…' : ''}</p>
                    <p className="text-[10px] text-slate-400 mt-1">{req.businessId.replace(/_/g, ' ')} · {req.createdAt.slice(0, 10)}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono text-[#E07A5F] text-sm font-bold">৳ {Number(req.requestedAmount).toLocaleString('en-BD')}</span>
                    <Button size="xs" variant="secondary" type="button" onClick={() => setReview({ id: req.id, action: 'REJECT', requestedAmount: Number(req.requestedAmount), approvedAmount: String(req.requestedAmount) })}>Reject</Button>
                    <Button size="xs" variant="gold" type="button" onClick={() => setReview({ id: req.id, action: 'APPROVE', requestedAmount: Number(req.requestedAmount), approvedAmount: String(req.requestedAmount) })}>Approve</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <div id="payroll-wallet-table">
      <Card className="p-5">
        <div className="flex justify-between gap-3 items-center flex-wrap mb-4">
          <p className="text-sm font-bold text-slate-800">Employee profitability and liabilities</p>
          <div className="flex flex-1 flex-wrap gap-2">
            <div className="relative flex-1 min-w-[10rem]">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input value={employeeFilter} onChange={e => setEmployeeFilter(e.target.value)} placeholder="Filter employee" className="w-full min-h-[44px] rounded-xl border border-black/[0.06] bg-white pl-9 pr-3 py-2 text-[11px] text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20 md:min-h-0" />
            </div>
          </div>
        </div>
        <div className="mb-4 flex gap-2 overflow-x-auto scrollbar-hide pb-1">
          {(['ALL', 'SALARY_ACCRUAL', 'COMMISSION', 'PENALTY', 'ADVANCE', 'WITHDRAWAL'] as const).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setLedgerTypeFilter(t)}
              className={`shrink-0 min-h-[44px] rounded-full border px-3.5 py-2 text-xs font-bold transition-colors md:min-h-0 md:px-3 md:py-1.5 ${
                ledgerTypeFilter === t
                  ? 'border-[#E07A5F]/30 bg-[#E07A5F]/10 text-[#E07A5F]'
                  : 'border-black/[0.06] text-slate-500 hover:text-slate-700 hover:bg-slate-50'
              }`}
            >
              {t.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
        {walletLoading ? <Skeleton className="h-40" /> : !(walletData?.wallets ?? []).length ? (
          <Empty
            icon="◈"
            title="No wallet ledger yet"
            desc="Run accrual or approve requests to create wallet entries."
            action={showApprovals ? <Button variant="gold" size="sm" onClick={() => void runAccrual()}>Run accrual</Button> : undefined}
          />
        ) : (
          <>
          <div className="hidden overflow-x-auto min-w-0 max-w-full max-h-[480px] md:block">
            <table className="w-full min-w-[1080px] text-left text-[11px]">
              <thead className="sticky top-0 z-[1] bg-white/95 backdrop-blur-sm border-b border-black/[0.06] text-xs text-slate-500 uppercase tracking-wider">
                <tr>
                  <th className="py-3 pr-3 font-medium">Employee</th>
                  <th className="py-3 pr-3 text-right font-medium">Earned</th>
                  <th className="py-3 pr-3 text-right font-medium">Commission</th>
                  <th className="py-3 pr-3 text-right font-medium">Bonus</th>
                  <th className="py-3 pr-3 text-right font-medium">Deductions</th>
                  <th className="py-3 pr-3 text-right font-medium">Withdrawn</th>
                  <th className="py-3 pr-3 text-right font-medium">Held balance</th>
                  <th className="py-3 pr-3 text-right font-medium">Profitability</th>
                  <th className="py-3 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-black/[0.04]">
                {filteredWallets.map((w: PayrollWallet) => (
                  <tr key={`${w.businessId}:${w.employeeId}`} className="transition-colors hover:bg-slate-50/80">
                    <td className="py-3 pr-3"><span className="text-slate-800 font-medium">{w.name}</span><span className="block text-slate-400 font-mono text-[10px]">{w.employeeId}</span></td>
                    <td className="py-3 pr-3 font-mono text-right text-slate-700">৳ {w.summary.lifetimeEarned.toLocaleString('en-BD')}</td>
                    <td className="py-3 pr-3 font-mono text-right text-emerald-600">৳ {w.summary.totalCommissions.toLocaleString('en-BD')}</td>
                    <td className="py-3 pr-3 font-mono text-right text-[#E07A5F]">৳ {w.summary.totalBonuses.toLocaleString('en-BD')}</td>
                    <td className="py-3 pr-3 font-mono text-right text-red-600">৳ {(w.summary.totalMealDeductions + w.summary.totalPenalties).toLocaleString('en-BD')}</td>
                    <td className="py-3 pr-3 font-mono text-right text-slate-500">৳ {w.summary.lifetimeWithdrawn.toLocaleString('en-BD')}</td>
                    <td className="py-3 pr-3 font-mono text-right text-emerald-600 font-medium">৳ {w.summary.companyLiability.toLocaleString('en-BD')}</td>
                    <td className="py-3 pr-3 font-mono text-right text-slate-500">{w.summary.totalAccrued ? `${Math.round(((w.summary.totalCommissions + w.summary.totalBonuses) / w.summary.totalAccrued) * 100)}% variable` : '—'}</td>
                    <td className="py-3"><Link href={`/employees/${encodeURIComponent(w.employeeId)}`} className="text-[#E07A5F] hover:text-[#c56a52] font-medium">Ledger</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile Expandable Cards */}
          <motion.div
            className="space-y-3 md:hidden"
            variants={_stagger} initial="hidden" animate="show"
          >
            {filteredWallets.slice(0, 80).map((w: PayrollWallet) => (
              <motion.div key={`${w.businessId}:${w.employeeId}`} variants={_fadeUp}>
                <Card interactive className="p-4 text-[11px]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-800">{w.name}</p>
                      <p className="font-mono text-slate-400 text-[10px]">{w.employeeId}</p>
                    </div>
                    <Link href={`/employees/${encodeURIComponent(w.employeeId)}`} className="shrink-0 text-[#E07A5F] font-medium text-xs">
                      Ledger →
                    </Link>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="rounded-xl border border-black/[0.06] bg-slate-50/50 px-3 py-2">
                      <p className="text-[10px] text-slate-500">Earned</p>
                      <p className="font-mono font-bold text-slate-800">৳ {w.summary.lifetimeEarned.toLocaleString('en-BD')}</p>
                    </div>
                    <div className="rounded-xl border border-black/[0.06] bg-emerald-50/50 px-3 py-2">
                      <p className="text-[10px] text-slate-500">Held balance</p>
                      <p className="font-mono font-bold text-emerald-600">৳ {w.summary.companyLiability.toLocaleString('en-BD')}</p>
                    </div>
                    <div className="rounded-xl border border-black/[0.06] bg-slate-50/50 px-3 py-2">
                      <p className="text-[10px] text-slate-500">Commission</p>
                      <p className="font-mono text-emerald-600">৳ {w.summary.totalCommissions.toLocaleString('en-BD')}</p>
                    </div>
                    <div className="rounded-xl border border-black/[0.06] bg-red-50/30 px-3 py-2">
                      <p className="text-[10px] text-slate-500">Deductions</p>
                      <p className="font-mono text-red-600">৳ {(w.summary.totalMealDeductions + w.summary.totalPenalties).toLocaleString('en-BD')}</p>
                    </div>
                  </div>
                </Card>
              </motion.div>
            ))}
          </motion.div>
          </>
        )}
      </Card>

      {showApprovals && (
        <Card className="p-5">
          <p className="text-sm font-bold text-slate-800">Meal Allowance Settings</p>
          <p className="mt-1 text-[11px] text-slate-500 max-w-2xl">
            Enable meal allowance for specific employees. On days when no food is cooked, enabled employees can request their allowance.
          </p>
          {mealLoading ? (
            <Skeleton className="h-40 mt-4" />
          ) : !mealRows.length ? (
            <div className="mt-4">
              <Empty icon="◷" title="No employees linked to this business yet." desc="Link staff with HR employee IDs and business access first." />
            </div>
          ) : (
            <div className="overflow-x-auto min-w-0 max-w-full max-h-[420px] mt-4">
              <table className="w-full min-w-[720px] text-left text-[11px]">
                <thead className="sticky top-0 z-[1] bg-white/95 backdrop-blur-sm border-b border-black/[0.06] text-xs text-slate-500 uppercase tracking-wider">
                  <tr>
                    <th className="py-3 pr-3 font-medium">Employee</th>
                    <th className="py-3 pr-3 font-medium">Phone</th>
                    <th className="py-3 pr-3 text-center font-medium">Enable</th>
                    <th className="py-3 pr-3 text-right font-medium">Amount (BDT)</th>
                    <th className="py-3 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/[0.04]">
                  {mealRows.map(row => (
                    <tr key={row.userId} className="hover:bg-slate-50/50 transition-colors">
                      <td className="py-3 pr-3">
                        <span className="text-slate-800 font-medium">{row.name}</span>
                        <span className="block text-slate-400 font-mono text-[10px]">{row.employeeId || '—'}</span>
                      </td>
                      <td className="py-3 pr-3 text-slate-500">{row.phone || '—'}</td>
                      <td className="py-3 pr-3 text-center">
                        <input
                          type="checkbox"
                          checked={row.enabled}
                          onChange={e =>
                            setMealRows(prev =>
                              prev.map(r => (r.userId === row.userId ? { ...r, enabled: e.target.checked } : r)),
                            )
                          }
                          className="h-4 w-4 rounded border-black/[0.1] accent-[#E07A5F]"
                        />
                      </td>
                      <td className="py-3 pr-3">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          disabled={!row.enabled}
                          value={row.amountBdt}
                          onChange={e =>
                            setMealRows(prev =>
                              prev.map(r => (r.userId === row.userId ? { ...r, amountBdt: e.target.value } : r)),
                            )
                          }
                          className="w-full max-w-[120px] ml-auto rounded-xl border border-black/[0.06] bg-white px-3 py-2 text-right font-mono text-slate-800 disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20"
                        />
                      </td>
                      <td className="py-3 text-right">
                        <Button
                          size="xs"
                          variant="secondary"
                          disabled={row.saving || (row.enabled && (!row.amountBdt || Number(row.amountBdt) <= 0))}
                          onClick={() => void saveMealProfile(row)}
                        >
                          {row.saving ? 'Saving…' : 'Save'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      </div>

      {review && (
        <MobileModalPortal open zIndex={80} onBackdropClick={() => setReview(null)}>
          <Card className="mobile-modal-shell w-full max-w-md sm:rounded-2xl border-[#E07A5F]/20">
            <div className="mobile-modal-header p-5 pb-3">
              <p className="text-sm font-bold text-slate-800">
                {review.action === 'APPROVE' ? 'Approve wallet request' : 'Reject wallet request'}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Requested amount: <span className="font-mono text-[#E07A5F] font-bold">৳ {review.requestedAmount.toLocaleString('en-BD')}</span>
              </p>
            </div>
            <div className="mobile-modal-body px-5">
              {review.action === 'APPROVE' && (
                <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500">
                  Approved amount
                  <input
                    autoFocus
                    inputMode="decimal"
                    type="number"
                    min="1"
                    value={review.approvedAmount}
                    onChange={e => setReview(r => r ? { ...r, approvedAmount: e.target.value } : r)}
                    className="mt-2 w-full rounded-xl border border-black/[0.06] bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-[#E07A5F]/20"
                  />
                </label>
              )}
            </div>
            <div className="mobile-modal-footer px-5 pt-3">
              <div className="flex justify-end gap-2">
                <Button size="xs" variant="secondary" type="button" onClick={() => setReview(null)}>Cancel</Button>
                <Button size="xs" variant={review.action === 'APPROVE' ? 'gold' : 'danger'} type="button" onClick={() => void submitReview()}>
                  {review.action === 'APPROVE' ? 'Confirm approval' : 'Confirm rejection'}
                </Button>
              </div>
            </div>
          </Card>
        </MobileModalPortal>
      )}

      <Card className="p-5">
        <p className="text-sm font-bold text-slate-800 mb-4">Legacy GAS rolling balances</p>
        {loading ? <Skeleton className="h-40" /> : roll.length === 0 ? (
          <Empty icon="⌁" title="No active payroll" desc="Add employees then log advances or salary payouts" />
        ) : (
          <div className="overflow-x-auto min-w-0 max-w-full max-h-[480px]">
            <table className="w-full min-w-[980px] text-left text-[11px]">
              <thead className="sticky top-0 z-[1] bg-white/95 backdrop-blur-sm border-b border-black/[0.06] text-xs text-slate-500 uppercase tracking-wider">
                <tr>
                  <th className="py-3 pr-3 font-medium">Employee</th>
                  <th className="py-3 pr-3 text-right font-medium">Salary</th>
                  <th className="py-3 pr-3 text-right font-medium">Paid</th>
                  <th className="py-3 pr-3 text-right font-medium">Advance</th>
                  <th className="py-3 pr-3 text-right font-medium">Due</th>
                  <th className="py-3 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-black/[0.04]">
                {roll.map(r => (
                  <tr key={r.emp_id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="py-3 pr-3 text-slate-800 font-medium">{r.name}</td>
                    <td className="py-3 pr-3 font-mono text-right text-slate-700">৳ {r.monthly_salary.toLocaleString('en-BD')}</td>
                    <td className="py-3 pr-3 font-mono text-right text-slate-500">৳ {r.salary_paid.toLocaleString('en-BD')}</td>
                    <td className="py-3 pr-3 font-mono text-right text-slate-500">৳ {Math.max(0, r.advance_balance).toLocaleString('en-BD')}</td>
                    <td className="py-3 pr-3 font-mono text-right text-[#E07A5F] font-medium">৳ {Math.max(0, r.current_due).toLocaleString('en-BD')}</td>
                    <td className="py-3"><Link href={`/employees/${r.emp_id}`} className="text-[#E07A5F] hover:text-[#c56a52] font-medium">Detail</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5 overflow-hidden">
        <p className="text-sm font-bold text-slate-800 mb-3">Timeline (recent)</p>
        {loading ? <Skeleton className="h-28" /> : !(data?.payroll_timeline ?? []).length ? (
          <p className="text-xs text-slate-500">Record advances or payouts from employee detail screens.</p>
        ) : (
          <div className="divide-y divide-black/[0.04] max-h-64 overflow-y-auto text-[11px]">
            {(data!.payroll_timeline ?? []).map(tx => (
              <div key={tx.tx_id} className="py-2.5 flex justify-between gap-2 items-center">
                <span className="text-slate-400 font-mono text-[10px]">{tx.date.slice(0, 10)}</span>
                <span className="flex-1 text-slate-700 font-medium">{tx.emp_name} · {tx.tx_type.replace('_',' ')}</span>
                <span className="font-mono text-[#E07A5F] font-bold">৳ {tx.amount.toLocaleString('en-BD')}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
      </PageEnter>
    </FinancePageChrome>
  )
}
