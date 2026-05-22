'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import { useHRDashboard } from '@/hooks/useHr'
import Link from 'next/link'
import { Card, KpiCard, Skeleton, Empty, Button } from '@/components/ui'
import { useActor } from '@/contexts/ActorContext'
import { can } from '@/lib/roles'
import { useBusiness } from '@/contexts/BusinessContext'
import type { PayrollWallet, WalletRequestDto, WalletSummaryResponse } from '@/types/payroll-wallet'
import { pdf } from '@react-pdf/renderer'
import { BusinessPayrollSummaryDocument } from '@/components/pdf/PayrollWalletDocuments'
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
      toast.error((e as Error).message || 'Could not load employee wallets')
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
    if (!compForm.employeeId || !amount || amount <= 0) {
      toast.error('Employee and positive amount required')
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
      actions={<div className="flex gap-2 flex-wrap justify-end"><Button size="xs" variant="gold" onClick={() => void runAccrual()}>Run accrual</Button><Button size="xs" variant="secondary" disabled={!walletData?.wallets.length} onClick={() => void exportPdf()}>PDF</Button><Button size="xs" variant="secondary" disabled={!walletData?.wallets.length} onClick={() => exportCsv()}>CSV</Button><Button size="xs" variant="secondary" disabled={!walletData?.wallets.length} onClick={() => void exportXlsx()}>Excel</Button><Link href="/employees"><Button size="xs" variant="secondary">Employees</Button></Link></div>}
    >
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard label="Monthly salary budget" value={loading ? '—' : Number(k?.total_monthly_salary ?? 0)} loading={loading} />
        <KpiCard label="Company liability" value={walletLoading ? '—' : Number(walletData?.totals.companyLiability ?? 0)} color="text-green-400" loading={walletLoading} />
        <KpiCard label="Commission totals" value={walletLoading ? '—' : Number(walletData?.totals.totalCommissions ?? 0)} color="text-green-400" loading={walletLoading} />
        <KpiCard label="Bonus totals" value={walletLoading ? '—' : Number(walletData?.totals.totalBonuses ?? 0)} color="text-gold-lt" loading={walletLoading} />
        <KpiCard label="Meal deductions" value={walletLoading ? '—' : Number(walletData?.totals.totalMealDeductions ?? 0)} color="text-red-400" loading={walletLoading} />
        <KpiCard label="Unpaid balance" value={walletLoading ? '—' : Number(walletData?.totals.currentBalance ?? 0)} loading={walletLoading} />
      </div>

      {showApprovals && (
        <Card className="p-5 border-gold-dim/25">
          <div className="flex justify-between gap-3 items-start flex-wrap mb-4">
            <div>
              <p className="text-sm font-bold text-cream">Compensation tools</p>
              <p className="text-[11px] text-zinc-500 mt-1">Post Eid bonus, performance bonus, overtime, reimbursement, meal deduction, penalty, or manual commission into the unified wallet ledger.</p>
            </div>
          </div>
          <form onSubmit={submitCompensation} className="grid md:grid-cols-[1.2fr_1fr_1fr_1fr_1.5fr_auto] gap-2 text-[11px]">
            <select value={compForm.employeeId} onChange={e => setCompForm(f => ({ ...f, employeeId: e.target.value }))} className="rounded-xl border border-border bg-black/30 px-3 py-2 text-cream">
              <option value="">Select employee</option>
              {compWallets.map(w => <option key={`${w.businessId}:${w.employeeId}`} value={w.employeeId}>{w.name} · {w.employeeId}</option>)}
            </select>
            <select value={compForm.type} onChange={e => setCompForm(f => ({ ...f, type: e.target.value }))} className="rounded-xl border border-border bg-black/30 px-3 py-2 text-cream">
              {['COMMISSION', 'EID_BONUS', 'PERFORMANCE_BONUS', 'OVERTIME', 'REIMBURSEMENT', 'MEAL_DEDUCTION', 'PENALTY', 'ADJUSTMENT'].map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
            </select>
            <input value={compForm.amount} onChange={e => setCompForm(f => ({ ...f, amount: e.target.value }))} type="number" min="1" step="1" placeholder="Amount" className="rounded-xl border border-border bg-black/30 px-3 py-2 text-cream font-mono" />
            <input value={compForm.date} onChange={e => setCompForm(f => ({ ...f, date: e.target.value }))} type="date" className="rounded-xl border border-border bg-black/30 px-3 py-2 text-cream" />
            <input value={compForm.note} onChange={e => setCompForm(f => ({ ...f, note: e.target.value }))} placeholder="Note" className="rounded-xl border border-border bg-black/30 px-3 py-2 text-cream" />
            <Button size="xs" variant="gold" type="submit" disabled={compBusy}>{compBusy ? 'Posting…' : 'Post'}</Button>
          </form>
          {orphanLedgerCount > 0 && (
            <p className="mt-3 text-[11px] text-amber-300/90 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2">
              {orphanLedgerCount} orphan ledger {orphanLedgerCount === 1 ? 'entry' : 'entries'} (not on roster / no linked user).{' '}
              <button
                type="button"
                className="text-gold-lt underline"
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
        <Card className="p-5 border-gold-dim/25">
          <div className="flex justify-between gap-3 items-start flex-wrap">
            <div>
              <p className="text-sm font-bold text-cream">Monthly payroll automation</p>
              <p className="text-[11px] text-zinc-500 mt-1">
                Runs automatically on day {automation?.dayOfMonth ?? 10} · {automation?.timezone ?? 'Asia/Dhaka'} · Cron path /api/cron/payroll-accrual
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
            <div className="rounded-2xl border border-border bg-black/20 p-3">
              <p className="text-[9px] uppercase tracking-wider text-zinc-600 font-bold">Monthly preview</p>
              <p className="font-mono text-green-400 text-lg font-bold mt-1">৳ {Number(preview?.totalPreviewSalary ?? 0).toLocaleString('en-BD')}</p>
              <p className="text-[10px] text-zinc-500">{preview?.employees.length ?? 0} linked employees · {preview?.alreadyAccruedCount ?? 0} already accrued</p>
            </div>
            <div className="md:col-span-2 rounded-2xl border border-border bg-black/20 p-3">
              <p className="text-[9px] uppercase tracking-wider text-zinc-600 font-bold mb-2">Accrual history</p>
              {!history.length ? <p className="text-[11px] text-zinc-600">No accrual runs yet.</p> : (
                <div className="grid gap-1 text-[11px] max-h-28 overflow-y-auto">
                  {history.slice(0, 6).map(run => (
                    <div key={run.id} className="flex justify-between gap-2 border-b border-border/50 pb-1">
                      <span className="font-mono text-zinc-500">{run.periodYm}</span>
                      <span className={run.status === 'SUCCESS' ? 'text-green-400' : run.status === 'RUNNING' ? 'text-amber-400' : 'text-red-400'}>{run.status}</span>
                      <span className="text-zinc-500">{run.trigger}</span>
                      <span className="font-mono text-gold-lt">+{run.createdCount} / skip {run.skippedCount}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {showApprovals && (
        <Card className="p-5 border-amber-500/20">
          <div className="flex justify-between items-center gap-3 mb-3 flex-wrap">
            <p className="text-sm font-bold text-cream">Pending wallet requests</p>
            <Button size="xs" variant="secondary" type="button" onClick={() => void loadWallets()}>Refresh</Button>
          </div>
          {walletLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !(walletData?.pendingRequests ?? []).length ? (
            <p className="text-[11px] text-zinc-500">No pending requests for your business scope.</p>
          ) : (
            <div className="overflow-x-auto space-y-2">
              {walletData!.pendingRequests.map(req => (
                <div key={req.id} className="flex flex-col sm:flex-row sm:items-center gap-2 border border-border rounded-xl p-3 text-[11px]">
                  <div className="flex-1 min-w-0">
                    <p className="text-cream font-medium">{req.type.replace(/_/g, ' ')} · {req.employeeId}</p>
                    <p className="text-zinc-400 mt-1">{req.reason.slice(0, 160)}{req.reason.length > 160 ? '…' : ''}</p>
                    <p className="text-[10px] text-zinc-600 mt-1">{req.businessId.replace(/_/g, ' ')} · {req.createdAt.slice(0, 10)}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono text-gold-lt text-sm">৳ {Number(req.requestedAmount).toLocaleString('en-BD')}</span>
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
          <p className="text-sm font-bold text-cream">Employee profitability and liabilities</p>
          <div className="flex gap-2 flex-wrap">
            <input value={employeeFilter} onChange={e => setEmployeeFilter(e.target.value)} placeholder="Filter employee" className="rounded-xl border border-border bg-black/30 px-3 py-2 text-[11px] text-cream" />
            <select value={ledgerTypeFilter} onChange={e => setLedgerTypeFilter(e.target.value)} className="rounded-xl border border-border bg-black/30 px-3 py-2 text-[11px] text-cream">
              {['ALL', 'SALARY_ACCRUAL', 'COMMISSION', 'EID_BONUS', 'PERFORMANCE_BONUS', 'OVERTIME', 'REIMBURSEMENT', 'MEAL_DEDUCTION', 'PENALTY', 'ADVANCE', 'WITHDRAWAL', 'ADJUSTMENT'].map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
        </div>
        {walletLoading ? <Skeleton className="h-40" /> : !(walletData?.wallets ?? []).length ? (
          <Empty icon="◈" title="No wallet ledger yet" desc="Run accrual or approve requests to create wallet entries." />
        ) : (
          <div className="table-scroll max-h-[480px]">
            <table className="w-full min-w-[1080px] text-left text-[11px]">
              <thead className="sticky top-0 bg-card border-b border-border text-zinc-500">
                <tr>
                  <th className="py-2 pr-3">Employee</th>
                  <th className="py-2 pr-3 text-right">Earned</th>
                  <th className="py-2 pr-3 text-right">Commission</th>
                  <th className="py-2 pr-3 text-right">Bonus</th>
                  <th className="py-2 pr-3 text-right">Deductions</th>
                  <th className="py-2 pr-3 text-right">Withdrawn</th>
                  <th className="py-2 pr-3 text-right">Held balance</th>
                  <th className="py-2 pr-3 text-right">Profitability</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {filteredWallets.map((w: PayrollWallet) => (
                  <tr key={`${w.businessId}:${w.employeeId}`} className="border-b border-border/60">
                    <td className="py-2 pr-3"><span className="text-cream">{w.name}</span><span className="block text-zinc-600 font-mono">{w.employeeId}</span></td>
                    <td className="py-2 pr-3 font-mono text-right">৳ {w.summary.lifetimeEarned.toLocaleString('en-BD')}</td>
                    <td className="py-2 pr-3 font-mono text-right text-green-400">৳ {w.summary.totalCommissions.toLocaleString('en-BD')}</td>
                    <td className="py-2 pr-3 font-mono text-right text-gold-lt">৳ {w.summary.totalBonuses.toLocaleString('en-BD')}</td>
                    <td className="py-2 pr-3 font-mono text-right text-red-400">৳ {(w.summary.totalMealDeductions + w.summary.totalPenalties).toLocaleString('en-BD')}</td>
                    <td className="py-2 pr-3 font-mono text-right text-zinc-400">৳ {w.summary.lifetimeWithdrawn.toLocaleString('en-BD')}</td>
                    <td className="py-2 pr-3 font-mono text-right text-green-400">৳ {w.summary.companyLiability.toLocaleString('en-BD')}</td>
                    <td className="py-2 pr-3 font-mono text-right text-zinc-400">{w.summary.totalAccrued ? `${Math.round(((w.summary.totalCommissions + w.summary.totalBonuses) / w.summary.totalAccrued) * 100)}% variable` : '—'}</td>
                    <td className="py-2"><Link href={`/employees/${encodeURIComponent(w.employeeId)}`} className="text-gold hover:underline">Ledger</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {showApprovals && (
        <Card className="p-5">
          <p className="text-sm font-bold text-cream">Meal Allowance Settings</p>
          <p className="mt-1 text-[11px] text-zinc-500 max-w-2xl">
            Enable meal allowance for specific employees. On days when no food is cooked, enabled employees can request their allowance.
          </p>
          {mealLoading ? (
            <Skeleton className="h-40 mt-4" />
          ) : !mealRows.length ? (
            <div className="mt-4">
              <Empty icon="◷" title="No employees linked to this business yet." desc="Link staff with HR employee IDs and business access first." />
            </div>
          ) : (
            <div className="table-scroll max-h-[420px] mt-4">
              <table className="w-full min-w-[720px] text-left text-[11px]">
                <thead className="sticky top-0 bg-card border-b border-border text-zinc-500">
                  <tr>
                    <th className="py-2 pr-3">Employee</th>
                    <th className="py-2 pr-3">Phone</th>
                    <th className="py-2 pr-3 text-center">Enable</th>
                    <th className="py-2 pr-3 text-right">Amount (BDT)</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {mealRows.map(row => (
                    <tr key={row.userId} className="border-b border-border/60">
                      <td className="py-2 pr-3">
                        <span className="text-cream">{row.name}</span>
                        <span className="block text-zinc-600 font-mono">{row.employeeId || '—'}</span>
                      </td>
                      <td className="py-2 pr-3 text-zinc-400">{row.phone || '—'}</td>
                      <td className="py-2 pr-3 text-center">
                        <input
                          type="checkbox"
                          checked={row.enabled}
                          onChange={e =>
                            setMealRows(prev =>
                              prev.map(r => (r.userId === row.userId ? { ...r, enabled: e.target.checked } : r)),
                            )
                          }
                          className="h-4 w-4 rounded border-border accent-gold"
                        />
                      </td>
                      <td className="py-2 pr-3">
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
                          className="w-full max-w-[120px] ml-auto rounded-xl border border-border bg-black/30 px-3 py-2 text-right font-mono text-cream disabled:opacity-40"
                        />
                      </td>
                      <td className="py-2 text-right">
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
          <Card className="mobile-modal-shell w-full max-w-md sm:rounded-3xl">
            <div className="mobile-modal-header p-5 pb-3">
              <p className="text-sm font-bold text-cream">
                {review.action === 'APPROVE' ? 'Approve wallet request' : 'Reject wallet request'}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                Requested amount: <span className="font-mono text-gold-lt">৳ {review.requestedAmount.toLocaleString('en-BD')}</span>
              </p>
            </div>
            <div className="mobile-modal-body px-5">
              {review.action === 'APPROVE' && (
                <label className="block text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                  Approved amount
                  <input
                    autoFocus
                    inputMode="decimal"
                    type="number"
                    min="1"
                    value={review.approvedAmount}
                    onChange={e => setReview(r => r ? { ...r, approvedAmount: e.target.value } : r)}
                    className="mt-2 w-full rounded-xl border border-border bg-black/30 px-3 py-2 text-sm text-cream outline-none focus:border-gold-dim/60"
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
        <p className="text-sm font-bold text-cream mb-4">Legacy GAS rolling balances</p>
        {loading ? <Skeleton className="h-40" /> : roll.length === 0 ? (
          <Empty icon="⌁" title="No active payroll" desc="Add employees then log advances or salary payouts" />
        ) : (
          <div className="table-scroll max-h-[480px]">
            <table className="w-full min-w-[980px] text-left text-[11px]">
              <thead className="sticky top-0 bg-card border-b border-border text-zinc-500">
                <tr>
                  <th className="py-2 pr-3">Employee</th>
                  <th className="py-2 pr-3 text-right">Salary</th>
                  <th className="py-2 pr-3 text-right">Paid</th>
                  <th className="py-2 pr-3 text-right">Advance</th>
                  <th className="py-2 pr-3 text-right">Due</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {roll.map(r => (
                  <tr key={r.emp_id} className="border-b border-border/60">
                    <td className="py-2 pr-3">{r.name}</td>
                    <td className="py-2 pr-3 font-mono text-right">৳ {r.monthly_salary.toLocaleString('en-BD')}</td>
                    <td className="py-2 pr-3 font-mono text-right text-zinc-400">৳ {r.salary_paid.toLocaleString('en-BD')}</td>
                    <td className="py-2 pr-3 font-mono text-right text-zinc-400">৳ {Math.max(0, r.advance_balance).toLocaleString('en-BD')}</td>
                    <td className="py-2 pr-3 font-mono text-right text-gold-lt">৳ {Math.max(0, r.current_due).toLocaleString('en-BD')}</td>
                    <td className="py-2"><Link href={`/employees/${r.emp_id}`} className="text-gold hover:underline">Detail</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5 overflow-hidden">
        <p className="text-sm font-bold text-cream mb-3">Timeline (recent)</p>
        {loading ? <Skeleton className="h-28" /> : !(data?.payroll_timeline ?? []).length ? (
          <p className="text-xs text-zinc-500">Record advances or payouts from employee detail screens.</p>
        ) : (
          <div className="divide-y divide-border max-h-64 overflow-y-auto text-[11px]">
            {(data!.payroll_timeline ?? []).map(tx => (
              <div key={tx.tx_id} className="py-2 flex justify-between gap-2">
                <span className="text-zinc-500 font-mono">{tx.date.slice(0, 10)}</span>
                <span className="flex-1 text-cream">{tx.emp_name} · {tx.tx_type.replace('_',' ')}</span>
                <span className="font-mono text-gold">৳ {tx.amount.toLocaleString('en-BD')}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </FinancePageChrome>
  )
}
