'use client'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { EmployeeAvatar } from '@/components/profile/EmployeeAvatar'
import { useHREmployees, useHRPayrollForEmployee, useHrAddPayroll } from '@/hooks/useHr'
import {
  buildSalarySlipBreakdown,
  formatSalarySlipPeriodLabel,
  salarySlipPeriodOptions,
} from '@/lib/salary-slip'
import { useBranding } from '@/contexts/BrandingContext'
import { useBusiness } from '@/contexts/BusinessContext'
import { Card, Button, Skeleton, Empty } from '@/components/ui'
import { confirmDialog } from '@/components/ui/confirm-dialog'
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
import { isWalletAdmin } from '@/lib/payroll-wallet'
import { formatMoneyBDT, roundMoney } from '@/lib/money'
import { api, APIError } from '@/lib/api'
import { parseSalaryCorrectionPayload } from '@/types/salary-correction'
import { MOTION } from '@/lib/motion'
import type { HRAddPayrollResponse } from '@/types/hr'

type LegacyPayTxType = 'deposit' | 'advance' | 'salary_payment' | 'adjustment'

type PayrollPayPayload = {
  emp_id: string
  tx_type: string
  amount: number
  date: string
  period_ym: string
  note: string
}

const LEGACY_PAY_TX_OPTIONS: { value: LegacyPayTxType; label: string }[] = [
  { value: 'deposit', label: '💰 Credit salary (add to wallet)' },
  { value: 'advance', label: '💸 Advance to employee (debit)' },
  { value: 'salary_payment', label: '⚠️ Mark salary as paid out (debit - usually via approval)' },
  { value: 'adjustment', label: '⚙️ Adjustment (correction)' },
]

function isDebitPayrollTx(txType: string) {
  return txType === 'advance' || txType === 'salary_payment'
}

function payrollWalletSkipMessage(wallet: HRAddPayrollResponse['wallet']): string {
  const skipMessages: Record<string, string> = {
    period_type_already_exists:
      `${wallet?.existingType || 'Entry'} for ${wallet?.existingPeriodYm || 'this period'} already exists. Use Adjustment to modify, or update the existing row.`,
    wallet_entry_already_mirrored: 'This entry was already mirrored (retry detected).',
    not_wallet_admin: 'You do not have permission to update the wallet ledger.',
    wallet_context_denied: 'Wallet access denied for this business.',
    missing_employee_or_amount: 'Invalid employee ID or amount.',
    legacy_write_failed: 'Legacy roll save failed before wallet mirror.',
    legacy_type_not_wallet_mirrored: 'This tx_type is not mirrored to wallet.',
    p2002_unknown_constraint: 'Wallet mirror blocked by a unique constraint.',
  }
  const reason = wallet?.skipped || 'unknown'
  return wallet?.hint || skipMessages[reason] || `Wallet not updated: ${reason}`
}

function payrollTxHelper(txType: string): { text: string; className: string } {
  if (txType === 'deposit') {
    return {
      text: '✓ This will INCREASE the employee\'s wallet balance.',
      className: 'text-emerald-600 font-bold',
    }
  }
  if (txType === 'advance') {
    return {
      text: '⚠ This will DECREASE balance (employee received cash early).',
      className: 'text-amber-600 font-bold',
    }
  }
  if (txType === 'salary_payment') {
    return {
      text: '⚠ Caution: Use only if you paid salary outside the wallet. Normal flow is employee withdrawal request → approval.',
      className: 'text-amber-600 font-bold',
    }
  }
  return {
    text: 'Manual correction — can be positive or negative depending on amount sign in ledger mirror.',
    className: 'text-muted font-bold',
  }
}

type CorrectionReversalDraft = {
  key: string
  ledgerEntryId: string
  amount: string
  reason: string
}

type PendingSalaryCorrectionRow = {
  id: string
  type: string
  createdAt: string
  reason: string
  requester?: { name: string } | null
  payloadSnapshot: unknown
}

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
  const canWriteWallet = isWalletAdmin(actorRole)
  const canReverseSalary = actorRole === 'SUPER_ADMIN' || actorRole === 'HR'
  const canResetAttendance = actorRole === 'SUPER_ADMIN'
  const { data: txs, loading, refetch } = useHRPayrollForEmployee(decoded || null)
  const { mutate: postPay, loading: paying } = useHrAddPayroll()
  const { branding } = useBranding()
  const { business } = useBusiness()
  const [openPay, setOpenPay] = useState(false)
  const [payTxType, setPayTxType] = useState<LegacyPayTxType>('deposit')
  const [payConfirm, setPayConfirm] = useState<PayrollPayPayload | null>(null)
  const [openSalary, setOpenSalary] = useState(false)
  const [savingSalary, setSavingSalary] = useState(false)
  const payrollFormRef = useRef<HTMLFormElement>(null)
  const salaryFormRef = useRef<HTMLFormElement>(null)
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const [wallet, setWallet] = useState<EmployeeWalletResponse | null>(null)
  const [walletLoading, setWalletLoading] = useState(true)
  const [showBalanceNote, setShowBalanceNote] = useState(false)
  const slipPeriodOptions = useMemo(() => salarySlipPeriodOptions(), [])
  const [slipPeriodYm, setSlipPeriodYm] = useState(() => slipPeriodOptions.current)
  const [attendance, setAttendance] = useState<EmployeeAttendanceResponse | null>(null)
  const [attendanceLoading, setAttendanceLoading] = useState(true)
  const [openCorrection, setOpenCorrection] = useState(false)
  const [correctionSubmitting, setCorrectionSubmitting] = useState(false)
  const [correctionAccrualId, setCorrectionAccrualId] = useState('')
  const [correctionProposed, setCorrectionProposed] = useState('')
  const [correctionReason, setCorrectionReason] = useState('')
  const [correctionReversals, setCorrectionReversals] = useState<CorrectionReversalDraft[]>([])
  const [pendingCorrections, setPendingCorrections] = useState<PendingSalaryCorrectionRow[]>([])
  const [pendingCorrectionsLoading, setPendingCorrectionsLoading] = useState(false)
  const [reversingEntryId, setReversingEntryId] = useState<string | null>(null)
  const [resettingAttendanceId, setResettingAttendanceId] = useState<string | null>(null)

  const employee = list?.employees.find(e => e.emp_id === decoded)
  const transactions = txs?.transactions ?? []
  const slipBreakdown = useMemo(
    () => buildSalarySlipBreakdown(wallet?.entries ?? [], slipPeriodYm),
    [wallet?.entries, slipPeriodYm],
  )

  const salaryAccrualEntries = useMemo(
    () => (wallet?.entries ?? []).filter(e => e.type === 'SALARY_ACCRUAL' && e.id),
    [wallet?.entries],
  )

  const reversalCandidateEntries = useMemo(
    () =>
      (wallet?.entries ?? []).filter(
        e => e.id && (e.type === 'WITHDRAWAL' || e.type === 'ADJUSTMENT'),
      ),
    [wallet?.entries],
  )

  const selectedAccrual = useMemo(
    () => salaryAccrualEntries.find(e => e.id === correctionAccrualId) ?? null,
    [salaryAccrualEntries, correctionAccrualId],
  )

  const correctionDelta = useMemo(() => {
    if (!selectedAccrual) return null
    const current = roundMoney(Number(selectedAccrual.amount || 0))
    const proposed = roundMoney(Number(correctionProposed || 0))
    if (!proposed) return null
    return proposed - current
  }, [selectedAccrual, correctionProposed])

  const slipModel: SalarySlipModel | null = employee
    ? {
        companyName: branding?.company_name ?? business.name,
        tagline: branding?.tagline ?? business.tagline,
        logoUrl: branding?.logo_url || null,
        employee,
        periodLabel: formatSalarySlipPeriodLabel(slipPeriodYm),
        breakdown: slipBreakdown,
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

  const loadPendingCorrections = useCallback(async (signal?: { cancelled: boolean }) => {
    if (!canWriteWallet || !decoded) return
    setPendingCorrectionsLoading(true)
    try {
      const result = await safeFetchJson<{ approvals: PendingSalaryCorrectionRow[] }>(
        `/api/approvals?status=PENDING&module=PAYROLL&limit=80`,
        { cache: 'no-store' },
      )
      if (!signal?.cancelled && result.ok) {
        const data = unwrapApiData<{ approvals: PendingSalaryCorrectionRow[] }>(
          result.data as Record<string, unknown>,
        )
        setPendingCorrections(
          (data.approvals || []).filter(row => {
            if (row.type !== 'SALARY_CORRECTION') return false
            const payload = parseSalaryCorrectionPayload(row.payloadSnapshot)
            return payload?.employeeId === decoded
          }),
        )
      }
    } finally {
      if (!signal?.cancelled) setPendingCorrectionsLoading(false)
    }
  }, [canWriteWallet, decoded])

  useEffect(() => {
    const signal = { cancelled: false }
    void loadPendingCorrections(signal)
    return () => { signal.cancelled = true }
  }, [loadPendingCorrections])

  useEffect(() => {
    const onUpdated = () => { void loadPendingCorrections() }
    window.addEventListener('alma:approvals-updated', onUpdated)
    return () => window.removeEventListener('alma:approvals-updated', onUpdated)
  }, [loadPendingCorrections])

  async function reverseSalaryAccrual(entryId: string, amount: number) {
    if (!canReverseSalary || reversingEntryId) return
    const ok = await confirmDialog({
      title: 'Reverse salary accrual',
      message: `Reverse full salary accrual of ${formatMoneyBDT(amount)}? This posts an equal ADJUSTMENT debit.`,
      confirmLabel: 'Reverse',
      danger: true,
    })
    if (!ok) return
    setReversingEntryId(entryId)
    try {
      const res = await fetch('/api/payroll/wallet/entries/reverse-accrual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id, accrual_entry_id: entryId }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || res.statusText)
      toast.success('Salary accrual reversed')
      void loadWallet()
    } catch (e) {
      toast.error((e as Error).message || 'Could not reverse accrual')
    } finally {
      setReversingEntryId(null)
    }
  }

  async function resetAttendanceRecord(recordId: string, attendanceDate: string) {
    if (!canResetAttendance || resettingAttendanceId) return
    const ok = await confirmDialog({ message: `Remove attendance for ${attendanceDate.slice(0, 10)}? Employee can check in again; any late penalty will be reversed.`, confirmLabel: 'Remove', danger: true })
    if (!ok) return
    setResettingAttendanceId(recordId)
    try {
      const res = await fetch(`/api/attendance/${encodeURIComponent(recordId)}`, { method: 'DELETE' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || res.statusText)
      toast.success('Attendance reset — employee can check in again')
      void loadAttendance()
      void loadWallet()
    } catch (e) {
      toast.error((e as Error).message || 'Could not reset attendance')
    } finally {
      setResettingAttendanceId(null)
    }
  }

  function resetCorrectionForm() {
    setCorrectionAccrualId('')
    setCorrectionProposed('')
    setCorrectionReason('')
    setCorrectionReversals([])
  }

  function openCorrectionModal() {
    resetCorrectionForm()
    setOpenCorrection(true)
  }

  function addCorrectionReversal() {
    setCorrectionReversals(prev => [
      ...prev,
      { key: `rev-${Date.now()}-${prev.length}`, ledgerEntryId: '', amount: '', reason: '' },
    ])
  }

  function updateCorrectionReversal(key: string, patch: Partial<CorrectionReversalDraft>) {
    setCorrectionReversals(prev => prev.map(row => (row.key === key ? { ...row, ...patch } : row)))
  }

  function removeCorrectionReversal(key: string) {
    setCorrectionReversals(prev => prev.filter(row => row.key !== key))
  }

  async function submitSalaryCorrection() {
    if (!employee || !selectedAccrual?.id) {
      toast.error('Select a salary accrual to correct')
      return
    }
    const periodYm = String(selectedAccrual.periodYm || '').trim()
    if (!periodYm) {
      toast.error('Selected accrual is missing a period')
      return
    }
    const currentAmount = roundMoney(Number(selectedAccrual.amount || 0))
    const proposedAmount = roundMoney(Number(correctionProposed))
    const reason = correctionReason.trim()

    if (!Number.isFinite(proposedAmount) || proposedAmount <= 0) {
      toast.error('Proposed amount must be greater than zero')
      return
    }
    if (proposedAmount === currentAmount) {
      toast.error('Proposed amount must differ from the current accrual')
      return
    }
    if (reason.length < 5) {
      toast.error('Reason must be at least 5 characters')
      return
    }

    const reversals = correctionReversals
      .filter(row => row.ledgerEntryId.trim())
      .map(row => {
        const amount = roundMoney(Number(row.amount))
        const revReason = row.reason.trim()
        if (!Number.isFinite(amount) || amount === 0) {
          throw new Error('Each reversal needs a non-zero amount')
        }
        if (!revReason) throw new Error('Each reversal needs a reason')
        return {
          ledger_entry_id: row.ledgerEntryId.trim(),
          amount,
          reason: revReason,
        }
      })

    setCorrectionSubmitting(true)
    try {
      await api.hr.requestSalaryCorrection({
        accrual_entry_id: selectedAccrual.id,
        employee_id: employee.emp_id,
        business_id: business.id,
        period_ym: periodYm,
        proposed_amount: proposedAmount,
        reason,
        reversals: reversals.length ? reversals : undefined,
      })
      toast.success('Salary correction requested. Awaiting super admin approval.')
      setOpenCorrection(false)
      resetCorrectionForm()
      void loadPendingCorrections()
      window.dispatchEvent(new Event('alma:approvals-updated'))
    } catch (e) {
      const message = e instanceof APIError ? e.message : (e as Error).message
      toast.error(message || 'Failed to request salary correction')
    } finally {
      setCorrectionSubmitting(false)
    }
  }

  async function executePay(payload: PayrollPayPayload, form?: HTMLFormElement | null) {
    const res = (await postPay(payload)) as HRAddPayrollResponse | null
    if (res?.ok) {
      if (res.wallet?.ok === false || res.wallet?.skipped) {
        toast.error(`Legacy roll saved but ${payrollWalletSkipMessage(res.wallet)}`)
      } else {
        toast.success('Payroll logged + wallet updated')
      }
      setOpenPay(false)
      setPayConfirm(null)
      setPayTxType('deposit')
      refetch()
      void loadWallet()
      form?.reset()
    } else {
      toast.error(`Failed: ${res?.error || 'unknown error'}`)
    }
  }

  async function submitPay(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!employee) return
    const fd = new FormData(e.currentTarget)
    const payload: PayrollPayPayload = {
      emp_id: employee.emp_id,
      tx_type: String(fd.get('tx_type') || payTxType),
      amount: Number(fd.get('amount') || 0),
      date: String(fd.get('date') || ''),
      period_ym: String(fd.get('period_ym') || ''),
      note: String(fd.get('note') || ''),
    }
    if (!payload.tx_type || !payload.amount) {
      toast.error('Transaction type & amount required')
      return
    }
    if (isDebitPayrollTx(payload.tx_type)) {
      setPayConfirm(payload)
      return
    }
    await executePay(payload, e.currentTarget)
  }

  async function submitSalary(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!employee) return
    const formEl = e.currentTarget // capture before any await — React nulls currentTarget afterwards
    const fd = new FormData(formEl)
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
      formEl.reset()
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
          <Link href="/employees" className="text-[#E07A5F] underline text-sm font-medium">← Employees</Link>
        </div>
      </FinancePageChrome>
    )
  }

  return (
    <FinancePageChrome
      title={employee.name}
      subtitle={`${employee.role || 'Contributor'} · ${employee.emp_id}`}
    >
      {/* Profile Header */}
      <motion.div {...MOTION.page}>
        <Card className="p-6 mb-5">
          <div className="flex flex-col sm:flex-row gap-5">
            <EmployeeAvatar
              userId={wallet?.user?.id}
              name={employee.name}
              imageUrl={wallet?.user?.profileImageUrl}
              imageVersion={wallet?.user?.updatedAt}
              size="xl"
              className="shrink-0"
            />
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-cream">{employee.name}</h2>
                  <p className="text-sm text-muted mt-0.5">{employee.role || 'Staff'} · <span className="font-mono">{employee.emp_id}</span></p>
                  <div className="flex flex-wrap gap-3 mt-2 text-xs text-muted">
                    {employee.phone && <span className="flex items-center gap-1"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>{employee.phone}</span>}
                    {employee.email && <span className="flex items-center gap-1"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>{employee.email}</span>}
                  </div>
                  {employee.address && <p className="text-xs text-muted mt-1">{employee.address}</p>}
                </div>
                <div className="text-right space-y-1">
                  <p className="text-2xl font-bold text-[#E07A5F] font-mono">{formatMoneyBDT(employee.monthly_salary)}</p>
                  <p className="text-[10px] text-muted uppercase tracking-wider">Monthly Salary</p>
                </div>
              </div>
            </div>
          </div>

          {/* Wallet Summary Strip */}
          {!walletLoading && wallet && (
            <div className="grid grid-cols-3 gap-3 mt-5 pt-5 border-t border-white/[0.06]">
              <div className="text-center">
                <p className="font-mono text-lg font-bold text-cream">৳ {Number(wallet.summary.lifetimeEarned).toLocaleString('en-BD')}</p>
                <p className="text-[10px] text-muted mt-0.5">Earned</p>
              </div>
              <div className="text-center">
                <p className="font-mono text-lg font-bold text-cream">৳ {Number(wallet.summary.lifetimeWithdrawn).toLocaleString('en-BD')}</p>
                <p className="text-[10px] text-muted mt-0.5">Withdrawn</p>
              </div>
              <div className="text-center relative">
                <button
                  type="button"
                  onClick={() => setShowBalanceNote(v => !v)}
                  className="w-full focus:outline-none cursor-pointer"
                  title="বিস্তারিত দেখতে ক্লিক করুন"
                >
                  <p className={`font-mono text-lg font-bold ${Number(wallet.summary.currentBalance) < 0 ? 'text-red-500' : 'text-emerald-600'}`}>
                    ৳ {Number(wallet.summary.currentBalance).toLocaleString('en-BD')}
                  </p>
                  <p className="text-[10px] text-muted mt-0.5">Current Balance</p>
                </button>
                {showBalanceNote && (
                  <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 z-10 w-44 rounded-lg border border-white/10 bg-card px-2.5 py-1.5 text-[11px] leading-snug text-cream shadow-lg">
                    {Number(wallet.summary.currentBalance) < 0
                      ? 'এটা company আপনার থেকে পায়'
                      : 'এটা আপনি company থেকে পাবেন'}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Toolbar */}
          <div className="flex flex-wrap gap-2 pt-4 mt-4 border-t border-white/[0.06] items-center">
            <div className="flex flex-wrap items-center gap-2 flex-1">
              {slipModel ? (
                <>
                  <label className="text-[10px] text-muted flex items-center gap-1.5">
                    Slip period
                    <select
                      value={slipPeriodYm}
                      onChange={e => setSlipPeriodYm(e.target.value)}
                      className="rounded-lg border border-white/[0.06] bg-card/85 px-2 py-1 text-[11px] text-cream focus:outline-none"
                    >
                      <option value={slipPeriodOptions.current}>
                        This month ({formatSalarySlipPeriodLabel(slipPeriodOptions.current)})
                      </option>
                      <option value={slipPeriodOptions.last}>
                        Last month ({formatSalarySlipPeriodLabel(slipPeriodOptions.last)})
                      </option>
                    </select>
                  </label>
                  <input
                    type="month"
                    value={slipPeriodYm}
                    onChange={e => setSlipPeriodYm(e.target.value || slipPeriodOptions.current)}
                    className="rounded-lg border border-white/[0.06] bg-card/85 px-2 py-1 text-[11px] font-mono text-cream focus:outline-none"
                    aria-label="Custom slip period"
                  />
                  <button
                    type="button"
                    className="text-[10px] text-[#E07A5F] font-medium underline"
                    onClick={() => document.getElementById('postgres-wallet-ledger')?.scrollIntoView({ behavior: 'smooth' })}
                  >
                    View detailed ledger
                  </button>
                </>
              ) : null}
            </div>
            {slipModel ? <SalarySlipToolbar model={slipModel} /> : null}
            {canWriteWallet && (
              <Button
                size="xs"
                variant="gold"
                onClick={() => {
                  setPayTxType('deposit')
                  setPayConfirm(null)
                  setOpenPay(true)
                }}
              >
                + Payroll entry
              </Button>
            )}
            <Link href="/employees" className="text-[11px] text-muted hover:text-cream font-medium">← Roster</Link>
          </div>
        </Card>
      </motion.div>

      {/* Attendance Summary */}
      <Card className="p-5 mb-5">
        <p className="text-sm font-bold text-cream mb-3">Attendance summary</p>
        {attendanceLoading ? <Skeleton className="h-36" /> : !attendance ? (
          <p className="text-xs text-muted">No attendance data available for this employee/business.</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <MiniStat label="Present days" valueLabel={`${attendance.summary.presentDays} days`} />
              <MiniStat label="Late days" valueLabel={`${attendance.summary.lateCount} days`} color="text-amber-600" />
              <MiniStat label="Penalties" value={attendance.summary.totalPenalties} color="text-red-600" />
              <MiniStat label="Waived" value={attendance.summary.waivedPenalties} color="text-emerald-600" />
              <MiniStat label="Avg duration" valueLabel={durationLabel(attendance.summary.averageWorkMinutes)} />
            </div>
            {!attendance.records.length ? (
              <p className="text-xs text-muted">No attendance records this month.</p>
            ) : (
              <div className="max-h-72 overflow-auto text-[11px]">
                <table className="w-full min-w-[720px]">
                  <thead className="sticky top-0 bg-card/88 backdrop-blur-sm border-b border-white/[0.06] text-xs text-muted uppercase tracking-wider">
                    <tr>
                      <th className="py-2.5 pr-3 text-left font-medium">Date</th>
                      <th className="py-2.5 pr-3 text-left font-medium">Check in</th>
                      <th className="py-2.5 pr-3 text-left font-medium">Check out</th>
                      <th className="py-2.5 pr-3 text-right font-medium">Worked</th>
                      <th className="py-2.5 pr-3 text-right font-medium">Late</th>
                      <th className="py-2.5 pr-3 text-right font-medium">Penalty</th>
                      {canResetAttendance ? <th className="py-2.5 text-right font-medium">Actions</th> : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {attendance.records.map(row => (
                      <tr key={row.id} className="hover:bg-white/[0.04]/50 transition-colors">
                        <td className="py-2.5 pr-3 font-mono text-cream">{row.attendanceDate.slice(0, 10)}</td>
                        <td className="py-2.5 pr-3 font-mono text-cream">{timeLabel(row.checkInAt)}</td>
                        <td className="py-2.5 pr-3 font-mono text-cream">{row.checkOutAt ? timeLabel(row.checkOutAt) : '—'}</td>
                        <td className="py-2.5 pr-3 text-right font-mono text-cream">{durationLabel(row.totalWorkMinutes)}</td>
                        <td className={`py-2.5 pr-3 text-right font-mono font-medium ${row.lateMinutes ? 'text-red-600' : 'text-emerald-600'}`}>{durationLabel(row.lateMinutes)}</td>
                        <td className="py-2.5 pr-3 text-right font-mono text-red-600">৳ {row.penaltyAmount.toLocaleString('en-BD')}</td>
                        {canResetAttendance ? (
                          <td className="py-2.5 text-right">
                            <Button
                              size="xs"
                              variant="secondary"
                              disabled={resettingAttendanceId === row.id}
                              onClick={() => void resetAttendanceRecord(row.id, row.attendanceDate)}
                            >
                              {resettingAttendanceId === row.id ? '…' : 'Reset'}
                            </Button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Salary Settings */}
      <Card className="p-5 mb-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <p className="text-sm font-bold text-cream">Salary settings</p>
            <p className="text-[11px] text-muted mt-1">Monthly base used for payroll accrual (GAS roster)</p>
          </div>
          {canEditSalary ? (
            <Button size="xs" variant="ghost" onClick={() => setOpenSalary(true)}>Edit salary</Button>
          ) : null}
        </div>
        <p className="font-mono text-2xl font-bold text-[#E07A5F]">
          {formatMoneyBDT(employee.monthly_salary)}
        </p>
        <p className="text-[10px] text-muted mt-2">Past accruals are not recalculated when salary changes.</p>
      </Card>

      {/* Wallet Ledger */}
      <div id="postgres-wallet-ledger">
      <Card className="p-5 mb-5">
        <p className="text-sm font-bold text-cream mb-3">Postgres wallet ledger</p>
        {walletLoading ? <Skeleton className="h-44" /> : !wallet ? (
          <p className="text-xs text-muted">No wallet data available for this employee/business.</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MiniStat label="Current balance" value={wallet.summary.currentBalance} color="text-emerald-600" />
              <MiniStat label="Company liability" value={wallet.summary.companyLiability} color="text-emerald-600" />
              <MiniStat label="Lifetime earned" value={wallet.summary.lifetimeEarned} />
              <MiniStat label="Lifetime withdrawn" value={wallet.summary.lifetimeWithdrawn} />
            </div>
            {!wallet.entries.length ? (
              <p className="text-xs text-muted">No ledger entries yet. Run monthly accrual from Payroll.</p>
            ) : (
              <div className="max-h-80 overflow-auto text-[11px]">
                <table className="w-full min-w-[760px]">
                  <thead className="sticky top-0 bg-card/88 backdrop-blur-sm border-b border-white/[0.06] text-xs text-muted uppercase tracking-wider">
                    <tr>
                      <th className="py-2.5 pr-3 text-left font-medium">Date</th>
                      <th className="py-2.5 pr-3 text-left font-medium">Type</th>
                      <th className="py-2.5 pr-3 text-right font-medium">Movement</th>
                      <th className="py-2.5 pr-3 text-right font-medium">Running</th>
                      <th className="py-2.5 text-left font-medium">Note</th>
                      {canReverseSalary ? <th className="py-2.5 text-right font-medium">Actions</th> : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {wallet.entries.slice().reverse().map(tx => (
                      <tr key={tx.id || `${tx.date}-${tx.type}`} className="hover:bg-white/[0.04]/50 transition-colors">
                        <td className="py-2.5 pr-3 font-mono text-cream">{String(tx.date).slice(0, 10)}</td>
                        <td className="py-2.5 pr-3">
                          <span className="inline-block text-[10px] font-medium px-2 py-0.5 rounded-lg bg-white/[0.06] text-muted-hi">
                            {tx.type.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className={`py-2.5 pr-3 text-right font-mono font-medium ${tx.signedAmount >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{tx.signedAmount >= 0 ? '+' : '-'}৳ {Math.abs(tx.signedAmount).toLocaleString('en-BD')}</td>
                        <td className="py-2.5 pr-3 text-right font-mono text-[#E07A5F] font-medium">৳ {tx.runningBalance.toLocaleString('en-BD')}</td>
                        <td className="py-2.5 text-muted max-w-[200px] truncate">{tx.note || '—'}</td>
                        {canReverseSalary ? (
                          <td className="py-2.5 text-right">
                            {tx.type === 'SALARY_ACCRUAL' && tx.id && tx.signedAmount > 0 ? (
                              <Button
                                size="xs"
                                variant="secondary"
                                disabled={reversingEntryId === tx.id}
                                onClick={() => void reverseSalaryAccrual(tx.id!, tx.signedAmount)}
                              >
                                {reversingEntryId === tx.id ? '…' : 'Reverse'}
                              </Button>
                            ) : null}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Salary Corrections */}
      {canWriteWallet ? (
        <Card className="p-5 mb-5">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
            <div>
              <p className="text-sm font-bold text-cream">Salary corrections</p>
              <p className="text-[11px] text-muted mt-1">Request approval to update an existing salary accrual</p>
            </div>
            <Button size="xs" variant="gold" onClick={openCorrectionModal}>
              + Request correction
            </Button>
          </div>

          {pendingCorrectionsLoading ? (
            <Skeleton className="h-16" />
          ) : pendingCorrections.length > 0 ? (
            <div className="space-y-2">
              {pendingCorrections.map(row => {
                const payload = parseSalaryCorrectionPayload(row.payloadSnapshot)
                if (!payload) return null
                const periodLabel = formatSalarySlipPeriodLabel(payload.periodYm)
                return (
                  <div
                    key={row.id}
                    className="rounded-xl border border-amber-200 bg-amber-50/50 px-3 py-2.5 text-[11px]"
                  >
                    <p className="font-bold text-amber-700">
                      Pending: {formatMoneyBDT(payload.currentAmount)} → {formatMoneyBDT(payload.proposedAmount)} ({periodLabel})
                    </p>
                    <p className="mt-1 text-muted">
                      Requested by {row.requester?.name || 'Admin'} on {new Date(row.createdAt).toLocaleDateString()}
                    </p>
                    <p className="mt-1 text-muted-hi line-clamp-2">Reason: {row.reason || payload.requestedReason}</p>
                    {payload.reversals?.length ? (
                      <p className="mt-1 text-muted">Reversals: {payload.reversals.length} entries</p>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : null}
        </Card>
      ) : null}
      </div>

      {/* Legacy Payroll History */}
      <Card className="p-5">
        <p className="text-sm font-bold text-cream mb-3">Legacy GAS payroll history</p>
        {loading ? <Skeleton className="h-44" /> : transactions.length === 0 ? (
          <p className="text-xs text-muted">No transactions logged yet.</p>
        ) : (
          <div className="max-h-96 overflow-auto text-[11px]">
            <table className="w-full min-w-[760px]">
              <thead className="sticky top-0 bg-card/88 backdrop-blur-sm border-b border-white/[0.06] text-xs text-muted uppercase tracking-wider">
                <tr>
                  <th className="py-2.5 pr-3 text-left font-medium">Date</th>
                  <th className="py-2.5 pr-3 text-left font-medium">Type</th>
                  <th className="py-2.5 pr-3 text-right font-medium">৳</th>
                  <th className="py-2.5 pr-3 text-left font-medium">Period</th>
                  <th className="py-2.5 text-left font-medium">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {transactions.map(tx => (
                  <tr key={tx.tx_id} className="hover:bg-white/[0.04]/50 transition-colors">
                    <td className="py-2.5 pr-3 font-mono text-cream">{tx.date.slice(0, 10)}</td>
                    <td className="py-2.5 pr-3">
                      <span className="inline-block text-[10px] font-medium px-2 py-0.5 rounded-lg bg-white/[0.06] text-muted-hi">
                        {tx.tx_type}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono text-[#E07A5F] font-medium">{tx.amount.toLocaleString('en-BD')}</td>
                    <td className="py-2.5 pr-3 text-muted-hi">{tx.period_ym}</td>
                    <td className="py-2.5 text-muted">{tx.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Modals */}
      {openSalary && employee && (
        <MobileModalPortal open zIndex={120} onBackdropClick={() => !savingSalary && setOpenSalary(false)} aria-label="Update employee salary">
          <Card className="mobile-modal-shell w-full max-w-md border-[#E07A5F]/20 sm:rounded-2xl">
            <div className="mobile-modal-header p-5 pb-3">
              <p className="text-sm font-bold text-cream">Update salary for {employee.name}</p>
            </div>
            <form ref={salaryFormRef} id="edit-salary-form" onSubmit={submitSalary} className="flex min-h-0 flex-1 flex-col text-xs">
              <div className="mobile-modal-body space-y-3 px-5 pb-4">
                <label className="block space-y-1">
                  <span className="text-muted">Current salary</span>
                  <input
                    readOnly
                    value={formatMoneyBDT(employee.monthly_salary)}
                    className="w-full rounded-xl bg-white/[0.04] border border-white/[0.06] px-3 py-2.5 font-mono text-sm text-muted"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-muted">New monthly salary (৳)</span>
                  <input
                    name="new_salary"
                    type="number"
                    min={1}
                    max={1_000_000}
                    step={1}
                    required
                    defaultValue={employee.monthly_salary}
                    className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 font-mono text-sm text-cream focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-muted">Effective from</span>
                  <input
                    name="effective_date"
                    type="date"
                    defaultValue={todayIso}
                    required
                    className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 font-mono text-sm text-cream focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20"
                  />
                </label>
                <p className="text-[10px] text-muted">
                  New monthly accrual will start from the effective date you choose (stored in audit for now).
                </p>
                <label className="block space-y-1">
                  <span className="text-muted">Reason (optional)</span>
                  <textarea
                    name="reason"
                    rows={2}
                    maxLength={500}
                    placeholder="e.g. annual increment, role change"
                    className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 text-sm text-cream focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20"
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

      {payConfirm && employee && (
        <MobileModalPortal open zIndex={130} onBackdropClick={() => setPayConfirm(null)} aria-label="Confirm wallet debit">
          <Card className="mobile-modal-shell w-full max-w-md border-amber-200 sm:rounded-2xl">
            <div className="mobile-modal-header p-5 pb-3">
              <p className="text-sm font-bold text-amber-700">Confirm wallet debit</p>
              <p className="mt-2 text-xs text-muted-hi leading-relaxed">
                This will <span className="font-bold text-red-600">DECREASE</span> {employee.name}&apos;s wallet balance by{' '}
                <span className="font-mono text-[#E07A5F] font-bold">৳ {payConfirm.amount.toLocaleString('en-BD')}</span>.
              </p>
              <p className="mt-2 text-xs text-muted">
                Current balance:{' '}
                <span className="font-mono text-cream">
                  ৳ {Number(wallet?.summary.currentBalance ?? 0).toLocaleString('en-BD')}
                </span>
                <br />
                After this entry:{' '}
                <span className="font-mono text-amber-600">
                  ৳ {(Number(wallet?.summary.currentBalance ?? 0) - payConfirm.amount).toLocaleString('en-BD')}
                </span>
              </p>
              <p className="mt-3 text-[11px] font-bold text-amber-600">
                Salary credits should usually use &quot;Credit salary (add to wallet)&quot;.
              </p>
            </div>
            <div className="mobile-modal-footer px-5 pt-3 pb-5">
              <div className="flex gap-2">
                <Button type="button" variant="ghost" className="flex-1 justify-center" onClick={() => setPayConfirm(null)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  className="flex-1 justify-center"
                  disabled={paying}
                  onClick={() => void executePay(payConfirm, payrollFormRef.current)}
                >
                  {paying ? 'Posting…' : 'Yes, deduct from wallet'}
                </Button>
              </div>
            </div>
          </Card>
        </MobileModalPortal>
      )}

      {openCorrection && employee && (
        <MobileModalPortal
          open
          zIndex={125}
          onBackdropClick={() => !correctionSubmitting && setOpenCorrection(false)}
          aria-label="Request salary correction"
        >
          <Card className="mobile-modal-shell w-full max-w-lg border-[#E07A5F]/20 sm:rounded-2xl">
            <div className="mobile-modal-header p-5 pb-3">
              <p className="text-sm font-bold text-cream">Request salary correction for {employee.name}</p>
            </div>
            <div className="mobile-modal-body space-y-4 px-5 pb-4 text-xs max-h-[70vh] overflow-y-auto">
              <section className="space-y-2">
                <p className="text-[10px] font-black uppercase tracking-wide text-muted">Step 1 · Target accrual</p>
                {!salaryAccrualEntries.length ? (
                  <p className="text-muted">No SALARY_ACCRUAL entries in this wallet yet.</p>
                ) : (
                  <div className="space-y-2">
                    {salaryAccrualEntries.map(entry => {
                      const amount = roundMoney(Number(entry.amount || 0))
                      const period = entry.periodYm
                        ? formatSalarySlipPeriodLabel(entry.periodYm)
                        : String(entry.date).slice(0, 10)
                      const selected = correctionAccrualId === entry.id
                      return (
                        <label
                          key={entry.id}
                          className={`flex cursor-pointer gap-3 rounded-xl border px-3 py-2.5 transition-all ${selected ? 'border-[#E07A5F]/40 bg-[#E07A5F]/5 shadow-sm' : 'border-white/[0.06] bg-white/[0.04]/50 hover:bg-white/[0.04]'}`}
                        >
                          <input
                            type="radio"
                            name="correction_accrual"
                            className="mt-1 accent-[#E07A5F]"
                            checked={selected}
                            onChange={() => setCorrectionAccrualId(entry.id || '')}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="font-bold text-cream">{period}</p>
                            <p className="font-mono text-[#E07A5F] mt-0.5">{formatMoneyBDT(amount)}</p>
                            <p className="text-muted mt-1 line-clamp-2">{entry.note || '—'}</p>
                          </div>
                        </label>
                      )
                    })}
                  </div>
                )}
              </section>

              <section className="space-y-2">
                <p className="text-[10px] font-black uppercase tracking-wide text-muted">Step 2 · New amount</p>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={correctionProposed}
                  onChange={e => setCorrectionProposed(e.target.value)}
                  disabled={!selectedAccrual}
                  placeholder={selectedAccrual ? `Current ${formatMoneyBDT(Number(selectedAccrual.amount || 0))}` : 'Select accrual first'}
                  className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 font-mono text-sm text-cream disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20"
                />
                {correctionDelta != null ? (
                  <p className={`font-mono font-bold ${correctionDelta >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    Change: {correctionDelta >= 0 ? '+' : '-'}
                    {formatMoneyBDT(Math.abs(correctionDelta))}
                  </p>
                ) : null}
              </section>

              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] font-black uppercase tracking-wide text-muted">Step 3 · Reverse other entries (optional)</p>
                  <Button type="button" size="xs" variant="ghost" disabled={!selectedAccrual} onClick={addCorrectionReversal}>
                    + Add reversal
                  </Button>
                </div>
                {!correctionReversals.length ? (
                  <p className="text-muted">Use this to cancel a wrong withdrawal or adjustment when approving.</p>
                ) : (
                  <div className="space-y-3">
                    {correctionReversals.map(row => (
                      <div key={row.key} className="rounded-xl border border-white/[0.06] bg-white/[0.04]/50 p-3 space-y-2">
                        <div className="flex justify-between items-center gap-2">
                          <span className="text-muted">Reversal</span>
                          <button
                            type="button"
                            className="text-red-600 text-[10px] font-bold"
                            onClick={() => removeCorrectionReversal(row.key)}
                          >
                            Remove
                          </button>
                        </div>
                        <select
                          value={row.ledgerEntryId}
                          onChange={e => updateCorrectionReversal(row.key, { ledgerEntryId: e.target.value })}
                          className="w-full rounded-lg bg-card/85 border border-white/[0.06] px-2 py-1.5 text-cream text-[11px] focus:outline-none"
                        >
                          <option value="">Select ledger entry…</option>
                          {reversalCandidateEntries.map(entry => (
                            <option key={entry.id} value={entry.id}>
                              {entry.type.replace(/_/g, ' ')} · {formatMoneyBDT(Math.abs(Number(entry.amount || 0)))} · {String(entry.note || entry.id).slice(0, 40)}
                            </option>
                          ))}
                        </select>
                        <input
                          type="number"
                          step={1}
                          value={row.amount}
                          onChange={e => updateCorrectionReversal(row.key, { amount: e.target.value })}
                          placeholder="Amount (+ credit back, − debit)"
                          className="w-full rounded-lg bg-card/85 border border-white/[0.06] px-2 py-1.5 font-mono text-sm focus:outline-none"
                        />
                        <input
                          type="text"
                          value={row.reason}
                          onChange={e => updateCorrectionReversal(row.key, { reason: e.target.value })}
                          placeholder="Why reverse this entry"
                          className="w-full rounded-lg bg-card/85 border border-white/[0.06] px-2 py-1.5 text-sm text-cream focus:outline-none"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="space-y-2">
                <p className="text-[10px] font-black uppercase tracking-wide text-muted">Step 4 · Reason (required)</p>
                <textarea
                  value={correctionReason}
                  onChange={e => setCorrectionReason(e.target.value)}
                  rows={3}
                  minLength={5}
                  maxLength={800}
                  placeholder="Explain why this accrual amount should change"
                  className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 text-sm text-cream focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20"
                />
              </section>
            </div>
            <div className="mobile-modal-footer px-5 pt-3">
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="gold"
                  className="flex-1 justify-center"
                  disabled={correctionSubmitting || !salaryAccrualEntries.length}
                  onClick={() => void submitSalaryCorrection()}
                >
                  {correctionSubmitting ? 'Submitting…' : 'Submit for approval'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="flex-1 justify-center"
                  disabled={correctionSubmitting}
                  onClick={() => setOpenCorrection(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </Card>
        </MobileModalPortal>
      )}

      {openPay && (
        <MobileModalPortal open zIndex={120} onBackdropClick={() => { setOpenPay(false); setPayConfirm(null) }} aria-label="Log payroll movement">
          <Card className="mobile-modal-shell w-full max-w-md border-[#E07A5F]/20 sm:rounded-2xl">
            <div className="mobile-modal-header p-5 pb-3">
              <p className="text-sm font-bold text-cream">Log payroll movement</p>
            </div>
            <form ref={payrollFormRef} id="log-payroll-form" onSubmit={submitPay} className="flex min-h-0 flex-1 flex-col text-xs">
              <div className="mobile-modal-body space-y-3 px-5 pb-4">
              <label className="block space-y-1">
                <span className="text-muted">Type</span>
                <select
                  name="tx_type"
                  value={payTxType}
                  onChange={e => setPayTxType(e.target.value as LegacyPayTxType)}
                  className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 text-cream text-sm focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20"
                  required
                >
                  {LEGACY_PAY_TX_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <p className={`text-[11px] mt-1.5 leading-snug ${payrollTxHelper(payTxType).className}`}>
                  {payrollTxHelper(payTxType).text}
                </p>
              </label>
              <label className="block space-y-1">
                <span className="text-muted">Amount (৳)</span>
                <input name="amount" type="number" step="0.01" required className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 font-mono text-sm text-cream focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className="text-muted">Effective date</span>
                  <input name="date" type="date" className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 font-mono text-sm text-cream focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20" />
                </label>
                <label className="block space-y-1">
                  <span className="text-muted">Period (YYYY-MM)</span>
                  <input name="period_ym" placeholder="2026-05" className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 font-mono text-sm text-cream focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20" />
                </label>
              </div>
              <label className="block space-y-1">
                <span className="text-muted">Note</span>
                <textarea name="note" rows={2} className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 text-sm text-cream focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20" />
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
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.04]/50 p-3">
      <p className="text-[9px] font-bold uppercase tracking-wider text-muted">{label}</p>
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
