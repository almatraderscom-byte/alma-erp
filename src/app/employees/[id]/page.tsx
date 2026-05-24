'use client'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { useHREmployees, useHRPayrollForEmployee, useHrAddPayroll } from '@/hooks/useHr'
import { computePayrollRoll } from '@/lib/hr-payroll-roll'
import { useBranding } from '@/contexts/BrandingContext'
import { useBusiness } from '@/contexts/BusinessContext'
import { useDateRange } from '@/contexts/DateRangeContext'
import { Card, Button, Skeleton, Empty } from '@/components/ui'
import { SalarySlipToolbar } from '@/components/finance/SalarySlipToolbar'
import type { SalarySlipModel } from '@/components/pdf/SalarySlipDocument'
import type { EmployeeWalletResponse } from '@/types/payroll-wallet'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import toast from 'react-hot-toast'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import { safeFetchJson } from '@/lib/safe-fetch'
import { unwrapApiData } from '@/lib/safe-api-response'
import { normalizeAlmaRole } from '@/lib/roles'
import { formatMoneyBDT, roundMoney } from '@/lib/money'

type EmployeeAttendanceResponse = {
  records: Array<{
    id: string
    attendanceDate: string
    checkInAt: string
    checkOutAt: string | null
    totalWorkMinutes: number
    lateMinutes: number
    penaltyAmount: number
  }>
  summary: {
    presentDays: number
    lateCount: number
    totalPenalties: number
    waivedPenalties: number
    averageWorkMinutes: number
  }
}

export default function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>()
  const decoded = decodeURIComponent(id || '')
  const { data: list, loading: listLoading, refetch: refetchEmployees } = useHREmployees()
  const { data: session } = useSession()
  const actorRole = normalizeAlmaRole(session?.user?.role)
  const canEditSalary = actorRole === 'SUPER_ADMIN' || actorRole === 'ADMIN' || actorRole === 'HR'
  const { data: txs, loading, refetch } = useHRPayrollForEmployee(decoded || null)
  const { mutate: postPay, loading: paying } = useHrAddPayroll()
  const { branding } = useBranding()
  const { business } = useBusiness()
  const { label } = useDateRange()
  const [openPay, setOpenPay] = useState(false)
  const [openSalary, setOpenSalary] = useState(false)
  const [savingSalary, setSavingSalary] = useState(false)
  const payrollFormRef = useRef<HTMLFormElement>(null)
  const salaryFormRef = useRef<HTMLFormElement>(null)
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const [wallet, setWallet] = useState<EmployeeWalletResponse | null>(null)
  const [walletLoading, setWalletLoading] = useState(true)
  const [attendance, setAttendance] = useState<EmployeeAttendanceResponse | null>(null)
  const [attendanceLoading, setAttendanceLoading] = useState(true)

  const employee = list?.employees.find(e => e.emp_id === decoded)
  const transactions = txs?.transactions ?? []
  const roll = useMemo(
    () => (employee ? computePayrollRoll(employee, transactions) : null),
    [employee, transactions],
  )

  const slipModel: SalarySlipModel | null =
    employee && roll
      ? {
          companyName: branding?.company_name ?? business.name,
          tagline: branding?.tagline ?? business.tagline,
          logoUrl: branding?.logo_url || null,
          employee,
          periodLabel: label,
          roll,
          generatedAt: new Date().toISOString().slice(0, 10),
        }
      : null

  const loadWallet = useCallback(async (signal?: { cancelled: boolean }) => {
      setWalletLoading(true)
      try {
        const res = await fetch(`/api/payroll/wallet/${encodeURIComponent(decoded)}?business_id=${business.id}`, { cache: 'no-store' })
        const j = await res.json().catch(() => ({}))
        if (!signal?.cancelled) setWallet(res.ok ? (j as EmployeeWalletResponse) : null)
      } finally {
        if (!signal?.cancelled) setWalletLoading(false)
      }
  }, [business.id, decoded])

  useEffect(() => {
    const signal = { cancelled: false }
    void loadWallet(signal)
    return () => { signal.cancelled = true }
  }, [loadWallet])

  const loadAttendance = useCallback(async (signal?: { cancelled: boolean }) => {
    setAttendanceLoading(true)
    try {
      const result = await safeFetchJson<EmployeeAttendanceResponse>(
        `/api/attendance?business_id=${business.id}&employee_id=${encodeURIComponent(decoded)}`,
        { cache: 'no-store' },
      )
      if (!signal?.cancelled) {
        setAttendance(
          result.ok
            ? unwrapApiData<EmployeeAttendanceResponse>(result.data as Record<string, unknown>)
            : null,
        )
      }
    } finally {
      if (!signal?.cancelled) setAttendanceLoading(false)
    }
  }, [business.id, decoded])

  useEffect(() => {
    const signal = { cancelled: false }
    void loadAttendance(signal)
    return () => { signal.cancelled = true }
  }, [loadAttendance])

  async function submitPay(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!employee) return
    const fd = new FormData(e.currentTarget)
    const payload = {
      emp_id: employee.emp_id,
      tx_type: String(fd.get('tx_type') || ''),
      amount: Number(fd.get('amount') || 0),
      date: String(fd.get('date') || ''),
      period_ym: String(fd.get('period_ym') || ''),
      note: String(fd.get('note') || ''),
    }
    if (!payload.tx_type || !payload.amount) {
      toast.error('Transaction type & amount required')
      return
    }
    const res = await postPay(payload)
    if (res?.ok) {
      toast.success('Payroll logged')
      setOpenPay(false)
      refetch()
      void loadWallet()
      e.currentTarget.reset()
    }
  }

  async function submitSalary(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!employee) return
    const fd = new FormData(e.currentTarget)
    const newSalary = roundMoney(Number(fd.get('new_salary') || 0))
    const effectiveDate = String(fd.get('effective_date') || todayIso)
    const reason = String(fd.get('reason') || '').trim()

    if (!newSalary || newSalary <= 0) {
      toast.error('Enter a valid salary amount')
      return
    }
    if (newSalary > 1_000_000) {
      toast.error('Salary cannot exceed ৳1,000,000')
      return
    }
    if (newSalary === roundMoney(employee.monthly_salary)) {
      toast.error('New salary must differ from current salary')
      return
    }

    setSavingSalary(true)
    try {
      const res = await fetch(`/api/hr/employees/${encodeURIComponent(employee.emp_id)}/salary`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: newSalary,
          businessId: business.id,
          effectiveDate,
          reason: reason || undefined,
        }),
      })
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; new_salary?: number }
      if (!res.ok || !j.ok) {
        toast.error(j.error || 'Failed to update salary')
        return
      }
      toast.success(`Salary updated to ${formatMoneyBDT(Number(j.new_salary ?? newSalary))}`)
      setOpenSalary(false)
      refetchEmployees()
      e.currentTarget.reset()
    } catch (err) {
      toast.error((err as Error).message || 'Failed to update salary')
    } finally {
      setSavingSalary(false)
    }
  }

  if (listLoading) {
    return (
      <FinancePageChrome title="Employee" subtitle="Profile & payroll ledger">
        <Skeleton className="h-48" />
      </FinancePageChrome>
    )
  }

  if (!employee) {
    return (
      <FinancePageChrome title="Employee" subtitle="Profile & payroll ledger">
        <Empty icon="◎" title="Not found" desc="Return to roster and choose an employee." />
        <div className="text-center mt-4">
          <Link href="/employees" className="text-gold-lt underline text-sm">← Employees</Link>
        </div>
      </FinancePageChrome>
    )
  }

  return (
    <FinancePageChrome
      title={employee.name}
      subtitle={`${employee.role || 'Contributor'} · ${employee.emp_id}`}
    >
      <Card className="p-5 space-y-2 text-xs text-zinc-400 mb-4">
        <div className="flex flex-wrap justify-between gap-3">
          <div>
            <p className="text-cream text-sm font-bold">{employee.name}</p>
            <p>{employee.phone || '—'} · {employee.email || 'No email on file'}</p>
            <p className="mt-1">{employee.address}</p>
          </div>
          <div className="text-right space-y-1 font-mono text-gold-lt">
            <p>Salary ৳ {employee.monthly_salary.toLocaleString('en-BD')}</p>
            <p>Earned ৳ {Number(wallet?.summary.lifetimeEarned ?? 0).toLocaleString('en-BD')}</p>
            <p>Withdrawn ৳ {Number(wallet?.summary.lifetimeWithdrawn ?? 0).toLocaleString('en-BD')}</p>
            <p className="text-cream font-bold">Held ৳ {Number(wallet?.summary.companyLiability ?? 0).toLocaleString('en-BD')}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 pt-3 justify-between items-center border-t border-border">
          {slipModel ? <SalarySlipToolbar model={slipModel} /> : null}
          <Link href="/employees" className="text-[11px] text-zinc-500 hover:text-cream underline">← Roster</Link>
        </div>
      </Card>

      <div className="flex justify-end mb-3">
        <Button size="xs" variant="gold" onClick={() => setOpenPay(true)}>+ Payroll entry</Button>
      </div>

      <Card className="p-5 mb-4 border-gold-dim/25">
        <p className="text-sm font-bold text-cream mb-3">Attendance summary</p>
        {attendanceLoading ? <Skeleton className="h-36" /> : !attendance ? (
          <p className="text-xs text-zinc-500">No attendance data available for this employee/business.</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <MiniStat label="Present days" valueLabel={`${attendance.summary.presentDays} days`} />
              <MiniStat label="Late days" valueLabel={`${attendance.summary.lateCount} days`} color="text-amber-300" />
              <MiniStat label="Penalties" value={attendance.summary.totalPenalties} color="text-red-400" />
              <MiniStat label="Waived" value={attendance.summary.waivedPenalties} color="text-green-400" />
              <MiniStat label="Avg duration" valueLabel={durationLabel(attendance.summary.averageWorkMinutes)} />
            </div>
            {!attendance.records.length ? (
              <p className="text-xs text-zinc-500">No attendance records this month.</p>
            ) : (
              <div className="table-scroll max-h-72 text-[11px]">
                <table className="w-full min-w-[720px]">
                  <thead className="sticky top-0 bg-card border-b border-border text-zinc-500">
                    <tr>
                      <th className="py-2 pr-3 text-left">Date</th>
                      <th className="py-2 pr-3 text-left">Check in</th>
                      <th className="py-2 pr-3 text-left">Check out</th>
                      <th className="py-2 pr-3 text-right">Worked</th>
                      <th className="py-2 pr-3 text-right">Late</th>
                      <th className="py-2 text-right">Penalty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attendance.records.map(row => (
                      <tr key={row.id} className="border-b border-border/60">
                        <td className="py-2 pr-3 font-mono">{row.attendanceDate.slice(0, 10)}</td>
                        <td className="py-2 pr-3 font-mono">{timeLabel(row.checkInAt)}</td>
                        <td className="py-2 pr-3 font-mono">{row.checkOutAt ? timeLabel(row.checkOutAt) : '—'}</td>
                        <td className="py-2 pr-3 text-right font-mono">{durationLabel(row.totalWorkMinutes)}</td>
                        <td className={`py-2 pr-3 text-right font-mono ${row.lateMinutes ? 'text-red-400' : 'text-green-400'}`}>{durationLabel(row.lateMinutes)}</td>
                        <td className="py-2 text-right font-mono text-red-400">৳ {row.penaltyAmount.toLocaleString('en-BD')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card className="p-5 mb-4 border-gold-dim/25">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <p className="text-sm font-bold text-cream">Salary settings</p>
            <p className="text-[11px] text-zinc-500 mt-1">Monthly base used for payroll accrual (GAS roster)</p>
          </div>
          {canEditSalary ? (
            <Button size="xs" variant="ghost" onClick={() => setOpenSalary(true)}>Edit salary</Button>
          ) : null}
        </div>
        <p className="font-mono text-2xl font-bold text-gold-lt">
          {formatMoneyBDT(employee.monthly_salary)}
        </p>
        <p className="text-[10px] text-zinc-600 mt-2">Past accruals are not recalculated when salary changes.</p>
      </Card>

      <Card className="p-5 mb-4 border-gold-dim/25">
        <p className="text-sm font-bold text-cream mb-3">Postgres wallet ledger</p>
        {walletLoading ? <Skeleton className="h-44" /> : !wallet ? (
          <p className="text-xs text-zinc-500">No wallet data available for this employee/business.</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MiniStat label="Current balance" value={wallet.summary.currentBalance} color="text-green-400" />
              <MiniStat label="Company liability" value={wallet.summary.companyLiability} color="text-green-400" />
              <MiniStat label="Lifetime earned" value={wallet.summary.lifetimeEarned} />
              <MiniStat label="Lifetime withdrawn" value={wallet.summary.lifetimeWithdrawn} />
            </div>
            {!wallet.entries.length ? (
              <p className="text-xs text-zinc-500">No ledger entries yet. Run monthly accrual from Payroll.</p>
            ) : (
              <div className="table-scroll max-h-80 text-[11px]">
                <table className="w-full min-w-[760px]">
                  <thead className="sticky top-0 bg-card border-b border-border text-zinc-500">
                    <tr>
                      <th className="py-2 pr-3 text-left">Date</th>
                      <th className="py-2 pr-3 text-left">Type</th>
                      <th className="py-2 pr-3 text-right">Movement</th>
                      <th className="py-2 pr-3 text-right">Running</th>
                      <th className="py-2 text-left">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wallet.entries.slice().reverse().map(tx => (
                      <tr key={tx.id || `${tx.date}-${tx.type}`} className="border-b border-border/60">
                        <td className="py-2 pr-3 font-mono">{String(tx.date).slice(0, 10)}</td>
                        <td className="py-2 pr-3">{tx.type.replace(/_/g, ' ')}</td>
                        <td className={`py-2 pr-3 text-right font-mono ${tx.signedAmount >= 0 ? 'text-green-400' : 'text-red-400'}`}>{tx.signedAmount >= 0 ? '+' : '-'}৳ {Math.abs(tx.signedAmount).toLocaleString('en-BD')}</td>
                        <td className="py-2 pr-3 text-right font-mono text-gold-lt">৳ {tx.runningBalance.toLocaleString('en-BD')}</td>
                        <td className="py-2 text-zinc-500">{tx.note || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <p className="text-sm font-bold text-cream mb-3">Legacy GAS payroll history</p>
        {loading ? <Skeleton className="h-44" /> : transactions.length === 0 ? (
          <p className="text-xs text-zinc-500">No transactions logged yet.</p>
        ) : (
          <div className="table-scroll max-h-96 text-[11px]">
            <table className="w-full min-w-[760px]">
              <thead className="sticky top-0 bg-card border-b border-border text-zinc-500">
                <tr>
                  <th className="py-2 pr-3 text-left">Date</th>
                  <th className="py-2 pr-3 text-left">Type</th>
                  <th className="py-2 pr-3 text-right">৳</th>
                  <th className="py-2 pr-3 text-left">Period</th>
                  <th className="py-2 text-left">Note</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map(tx => (
                  <tr key={tx.tx_id} className="border-b border-border/60">
                    <td className="py-2 pr-3 font-mono">{tx.date.slice(0, 10)}</td>
                    <td className="py-2 pr-3">{tx.tx_type}</td>
                    <td className="py-2 pr-3 text-right font-mono text-gold-lt">{tx.amount.toLocaleString('en-BD')}</td>
                    <td className="py-2 pr-3">{tx.period_ym}</td>
                    <td className="py-2 text-zinc-500">{tx.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {openSalary && employee && (
        <MobileModalPortal open zIndex={120} onBackdropClick={() => !savingSalary && setOpenSalary(false)} aria-label="Update employee salary">
          <Card className="mobile-modal-shell w-full max-w-md border-gold-dim/30 sm:rounded-2xl">
            <div className="mobile-modal-header p-5 pb-3">
              <p className="text-sm font-bold text-cream">Update salary for {employee.name}</p>
            </div>
            <form ref={salaryFormRef} id="edit-salary-form" onSubmit={submitSalary} className="flex min-h-0 flex-1 flex-col text-xs">
              <div className="mobile-modal-body space-y-3 px-5 pb-4">
                <label className="block space-y-1">
                  <span className="text-zinc-500">Current salary</span>
                  <input
                    readOnly
                    value={formatMoneyBDT(employee.monthly_salary)}
                    className="w-full rounded-xl bg-black/30 border border-border px-3 py-2 font-mono text-sm text-zinc-400"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-zinc-500">New monthly salary (৳)</span>
                  <input
                    name="new_salary"
                    type="number"
                    min={1}
                    max={1_000_000}
                    step={1}
                    required
                    defaultValue={employee.monthly_salary}
                    className="w-full rounded-xl bg-card border border-border px-3 py-2 font-mono text-sm text-cream"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-zinc-500">Effective from</span>
                  <input
                    name="effective_date"
                    type="date"
                    defaultValue={todayIso}
                    required
                    className="w-full rounded-xl bg-card border border-border px-3 py-2 font-mono text-sm"
                  />
                </label>
                <p className="text-[10px] text-zinc-500">
                  New monthly accrual will start from the effective date you choose (stored in audit for now).
                </p>
                <label className="block space-y-1">
                  <span className="text-zinc-500">Reason (optional)</span>
                  <textarea
                    name="reason"
                    rows={2}
                    maxLength={500}
                    placeholder="e.g. annual increment, role change"
                    className="w-full rounded-xl bg-card border border-border px-3 py-2 text-sm text-cream"
                  />
                </label>
              </div>
              <div className="mobile-modal-footer px-5 pt-3">
                <div className="flex gap-2">
                  <Button type="button" variant="gold" className="flex-1 justify-center" disabled={savingSalary} onClick={() => salaryFormRef.current?.requestSubmit()}>
                    {savingSalary ? 'Saving…' : 'Save'}
                  </Button>
                  <Button type="button" variant="ghost" className="flex-1 justify-center" disabled={savingSalary} onClick={() => setOpenSalary(false)}>Cancel</Button>
                </div>
              </div>
            </form>
          </Card>
        </MobileModalPortal>
      )}

      {openPay && (
        <MobileModalPortal open zIndex={120} onBackdropClick={() => setOpenPay(false)} aria-label="Log payroll movement">
          <Card className="mobile-modal-shell w-full max-w-md border-gold-dim/30 sm:rounded-2xl">
            <div className="mobile-modal-header p-5 pb-3">
              <p className="text-sm font-bold text-cream">Log payroll movement</p>
            </div>
            <form ref={payrollFormRef} id="log-payroll-form" onSubmit={submitPay} className="flex min-h-0 flex-1 flex-col text-xs">
              <div className="mobile-modal-body space-y-3 px-5 pb-4">
              <label className="block space-y-1">
                <span className="text-zinc-500">Type</span>
                <select name="tx_type" className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream text-sm" required>
                  <option value="advance">advance</option>
                  <option value="deposit">deposit</option>
                  <option value="salary_payment">salary_payment</option>
                  <option value="adjustment">adjustment</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-zinc-500">Amount (৳)</span>
                <input name="amount" type="number" step="0.01" required className="w-full rounded-xl bg-card border border-border px-3 py-2 font-mono text-sm" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className="text-zinc-500">Effective date</span>
                  <input name="date" type="date" className="w-full rounded-xl bg-card border border-border px-3 py-2 font-mono text-sm" />
                </label>
                <label className="block space-y-1">
                  <span className="text-zinc-500">Period (YYYY-MM)</span>
                  <input name="period_ym" placeholder="2026-05" className="w-full rounded-xl bg-card border border-border px-3 py-2 font-mono text-sm" />
                </label>
              </div>
              <label className="block space-y-1">
                <span className="text-zinc-500">Note</span>
                <textarea name="note" rows={2} className="w-full rounded-xl bg-card border border-border px-3 py-2 text-sm text-cream" />
              </label>
              </div>
              <div className="mobile-modal-footer px-5 pt-3">
                <div className="flex gap-2">
                  <Button type="button" variant="gold" className="flex-1 justify-center" disabled={paying} onClick={() => payrollFormRef.current?.requestSubmit()}>
                    {paying ? 'Saving…' : 'Save entry'}
                  </Button>
                  <Button type="button" variant="ghost" className="flex-1 justify-center" onClick={() => setOpenPay(false)}>Cancel</Button>
                </div>
              </div>
            </form>
          </Card>
        </MobileModalPortal>
      )}
    </FinancePageChrome>
  )
}

function MiniStat({ label, value = 0, valueLabel, color = 'text-cream' }: { label: string; value?: number; valueLabel?: string; color?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-black/20 p-3">
      <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-600">{label}</p>
      <p className={`mt-1 font-mono text-sm font-bold ${color}`}>{valueLabel ?? `৳ ${Number(value || 0).toLocaleString('en-BD')}`}</p>
    </div>
  )
}

function durationLabel(minutes: number) {
  const h = Math.floor(Number(minutes || 0) / 60)
  const m = Number(minutes || 0) % 60
  if (!h) return `${m}m`
  return `${h}h ${m}m`
}

function timeLabel(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
