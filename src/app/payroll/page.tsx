'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import { useHRDashboard } from '@/hooks/useHr'
import Link from 'next/link'
import { Avatar, Card, Empty, Progress, Skeleton, Button } from '@/components/ui'
import { PageEnter } from '@/components/layout/AgentAccess'
import { useActor } from '@/contexts/ActorContext'
import { can, isSystemOwner } from '@/lib/roles'
import {
  BKASH_APP_URL,
  clearBkashSendPending,
  copyTextToClipboard,
  extractTrxIdFromText,
  readBkashSendPending,
  readClipboardText,
  saveBkashSendPending,
} from '@/lib/bkash-send-flow'
import { roundMoney } from '@/lib/money'
import { useBusiness } from '@/contexts/BusinessContext'
import { BusinessSwitcherCompact } from '@/components/layout/BusinessSwitcher'
import { cn } from '@/lib/utils'
const _stagger = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } }
const _fadeUp = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: [0.22, 1, 0.36, 1] } } }
import type { PayrollWallet, WalletRequestDto, WalletSummaryResponse } from '@/types/payroll-wallet'
import { downloadBlob, payrollWalletsToCsv, payrollWalletsToWorkbook } from '@/lib/export-payroll-wallet'
import toast from 'react-hot-toast'
import { safeFetchJsonWithToast } from '@/lib/safe-fetch'
import { unwrapApiData } from '@/lib/safe-api-response'
import { WALLET_TYPE_LABEL_BN, dateBn, periodYmBn, toBnDigits } from '@/lib/wallet-labels'

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

type DrivingProfileRow = {
  user: MealProfileUser
  profile: { id: string; enabled: boolean } | null
  drivingStatus?: 'ACTIVE' | 'PENDING' | null
}

type DrivingProfileRowState = {
  userId: string
  name: string
  phone: string | null
  employeeId: string
  enabled: boolean
  saving: boolean
  drivingStatus: 'ACTIVE' | 'PENDING' | null
  toggling: boolean
}

const PAYROLL_COMPENSATION_TYPES = [
  { value: 'SALARY_ACCRUAL', kind: 'credit' as const },
  { value: 'COMMISSION', kind: 'credit' as const },
  { value: 'EID_BONUS', kind: 'credit' as const },
  { value: 'PERFORMANCE_BONUS', kind: 'credit' as const },
  { value: 'OVERTIME', kind: 'credit' as const },
  { value: 'REIMBURSEMENT', kind: 'credit' as const },
  { value: 'MEAL_DEDUCTION', kind: 'debit' as const },
  { value: 'PENALTY', kind: 'debit' as const },
  { value: 'ADJUSTMENT', kind: 'adjust' as const },
] as const

const LEDGER_FILTER_TYPES = ['ALL', 'SALARY_ACCRUAL', 'COMMISSION', 'PENALTY', 'ADVANCE', 'WITHDRAWAL'] as const

type TabKey = 'month' | 'history' | 'requests' | 'tools'

/** Salary cycle: on day N of the current month, the *previous* month's salary is credited. */
function currentCyclePeriodYm(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: 'numeric' }).formatToParts(new Date())
  const y = Number(parts.find(p => p.type === 'year')?.value)
  const m = Number(parts.find(p => p.type === 'month')?.value)
  const prevM = m === 1 ? 12 : m - 1
  const prevY = m === 1 ? y - 1 : y
  return `${prevY}-${String(prevM).padStart(2, '0')}`
}

function currentCalendarYm(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: 'numeric' }).formatToParts(new Date())
  const y = Number(parts.find(p => p.type === 'year')?.value)
  const m = Number(parts.find(p => p.type === 'month')?.value)
  return `${y}-${String(m).padStart(2, '0')}`
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
  const [walletError, setWalletError] = useState<string | null>(null)
  const [automation, setAutomation] = useState<{ enabled: boolean; dayOfMonth: number; timezone: string; heldBusinessIds?: string[] } | null>(null)
  const [preview, setPreview] = useState<{ totalPreviewSalary: number; alreadyAccruedCount: number; employees: Array<{ employeeId: string; name: string; salary: number; alreadyAccrued: boolean }> } | null>(null)
  const [history, setHistory] = useState<Array<{ id: string; periodYm: string; status: string; trigger: string; createdCount: number; skippedCount: number; createdAt: string; error?: string | null }>>([])
  const [review, setReview] = useState<{ id: string; action: 'APPROVE' | 'REJECT'; type: string; requestedAmount: number; approvedAmount: string; transactionId: string; paidVia: string; employeeId?: string; businessId?: string; payout?: WalletRequestDto['payout']; resumedFromBkash?: boolean } | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [ledgerTypeFilter, setLedgerTypeFilter] = useState('ALL')
  const [employeeFilter, setEmployeeFilter] = useState('')
  const [compForm, setCompForm] = useState({ employeeId: '', type: 'EID_BONUS', amount: '', note: '', date: new Date().toISOString().slice(0, 10) })
  const [compBusy, setCompBusy] = useState(false)
  const [mealRows, setMealRows] = useState<MealProfileRowState[]>([])
  const [mealLoading, setMealLoading] = useState(false)
  const [drivingRows, setDrivingRows] = useState<DrivingProfileRowState[]>([])
  const [drivingLoading, setDrivingLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<TabKey>('month')
  const [pendingScrollToLedger, setPendingScrollToLedger] = useState(false)
  const walletRequestId = useRef(0)

  const showApprovals = can(role, 'advanceApprove')
  // bKash send flow is deliberately owner-only — normal admins keep the manual TrxID field.
  const ownerBkashFlow = isSystemOwner(role)

  // When the owner comes back from the bKash app, re-open the confirm sheet for the
  // in-flight withdrawal. visibilitychange fires on both Capacitor shell resume and
  // mobile-web tab return; the mount-time call covers a full app relaunch (iOS may
  // kill the WebView while the owner is inside bKash — state lives in localStorage).
  useEffect(() => {
    if (!ownerBkashFlow) return
    const restore = () => {
      const pending = readBkashSendPending()
      if (!pending || pending.surface !== 'payroll') return
      setReview(prev => prev ?? {
        id: pending.requestId,
        action: 'APPROVE',
        type: 'WITHDRAWAL',
        requestedAmount: pending.requestedAmount,
        approvedAmount: String(pending.approvedAmount || pending.requestedAmount),
        transactionId: '',
        paidVia: 'BKASH',
        employeeId: pending.employeeId,
        businessId: pending.businessId,
        payout: {
          methodId: null,
          label: 'bKash',
          accountHolder: pending.recipientName,
          accountNumber: pending.recipientNumber,
          accountNumberMasked: pending.recipientNumber,
          isVerified: false,
          status: 'ACTIVE',
          provider: 'BKASH',
        },
        resumedFromBkash: true,
      })
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
  }, [ownerBkashFlow])

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
      const s = unwrapApiData<{ setting: { enabled: boolean; dayOfMonth: number; timezone: string; heldBusinessIds?: string[] } }>(settingRes.data as Record<string, unknown>)
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
    const amount = roundMoney(Number(row.amountBdt))
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

  const loadDrivingProfiles = useCallback(async () => {
    if (!showApprovals) return
    setDrivingLoading(true)
    try {
      const result = await safeFetchJsonWithToast<{ rows?: DrivingProfileRow[] }>(
        `/api/payroll/driving-mode/profiles?business_id=${encodeURIComponent(business.id)}`,
        { cache: 'no-store', toastOnError: false },
      )
      if (!result.ok) throw new Error(result.error.message)
      const payload = unwrapApiData<{ rows?: DrivingProfileRow[] }>(result.data as Record<string, unknown>)
      setDrivingRows(
        (payload.rows ?? []).map(row => ({
          userId: row.user.id,
          name: row.user.name,
          phone: row.user.phone,
          employeeId: row.user.employeeIdGas || '',
          enabled: row.profile?.enabled ?? false,
          saving: false,
          drivingStatus: row.drivingStatus ?? null,
          toggling: false,
        })),
      )
    } catch (e) {
      toast.error((e as Error).message || 'Could not load driving mode settings')
      setDrivingRows([])
    } finally {
      setDrivingLoading(false)
    }
  }, [business.id, showApprovals])

  useEffect(() => {
    void loadDrivingProfiles()
  }, [loadDrivingProfiles])

  async function saveDrivingProfile(row: DrivingProfileRowState) {
    if (row.saving) return
    setDrivingRows(prev => prev.map(r => (r.userId === row.userId ? { ...r, saving: true } : r)))
    try {
      const result = await safeFetchJsonWithToast<{ profile?: { enabled: boolean } }>(
        '/api/payroll/driving-mode/profiles',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            business_id: business.id,
            userId: row.userId,
            employeeId: row.employeeId,
            enabled: row.enabled,
          }),
        },
      )
      if (!result.ok) throw new Error(result.error.message)
      const saved = unwrapApiData<{ profile?: { enabled: boolean } }>(result.data as Record<string, unknown>)
      toast.success(`Driving mode ${row.enabled ? 'enabled' : 'disabled'} for ${row.name}`)
      setDrivingRows(prev =>
        prev.map(r =>
          r.userId === row.userId ? { ...r, enabled: saved.profile?.enabled ?? row.enabled, saving: false } : r,
        ),
      )
    } catch (e) {
      toast.error((e as Error).message || 'Could not save driving mode setting')
      setDrivingRows(prev => prev.map(r => (r.userId === row.userId ? { ...r, saving: false } : r)))
    }
  }

  async function toggleDrivingNow(row: DrivingProfileRowState) {
    if (row.toggling) return
    const turningOn = row.drivingStatus !== 'ACTIVE'
    setDrivingRows(prev => prev.map(r => (r.userId === row.userId ? { ...r, toggling: true } : r)))
    try {
      const endpoint = turningOn
        ? '/api/payroll/driving-mode/start'
        : '/api/payroll/driving-mode/end'
      const result = await safeFetchJsonWithToast(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id, userId: row.userId }),
      })
      if (!result.ok) throw new Error(result.error.message)
      toast.success(turningOn ? `${row.name} এখন ড্রাইভিং মোডে` : `${row.name}-এর ড্রাইভিং মোড বন্ধ করা হলো`)
      setDrivingRows(prev =>
        prev.map(r =>
          r.userId === row.userId ? { ...r, drivingStatus: turningOn ? 'ACTIVE' : null, toggling: false } : r,
        ),
      )
    } catch (e) {
      toast.error((e as Error).message || 'Could not change driving mode')
      setDrivingRows(prev => prev.map(r => (r.userId === row.userId ? { ...r, toggling: false } : r)))
    }
  }

  /**
   * Copy the recipient's number and remember the in-flight request — all synchronous,
   * because the caller is an <a href={BKASH_APP_URL}> whose default navigation opens
   * the bKash app. iOS only honours that Universal Link while the gesture flag is
   * live, so nothing here may await (the original bug) and we must not preventDefault.
   */
  function startBkashSend() {
    if (!review?.payout?.accountNumber || review.payout.accountNumber === '—') return
    const approved = roundMoney(Number(review.approvedAmount || review.requestedAmount))
    const copied = copyTextToClipboard(review.payout.accountNumber)
    saveBkashSendPending({
      surface: 'payroll',
      requestId: review.id,
      employeeId: review.employeeId || '',
      businessId: review.businessId || '',
      requestedAmount: review.requestedAmount,
      approvedAmount: approved > 0 ? approved : review.requestedAmount,
      recipientNumber: review.payout.accountNumber,
      recipientName: review.payout.accountHolder ?? null,
      startedAt: Date.now(),
    })
    toast.success(copied
      ? 'নম্বর কপি হয়েছে — বিকাশে Send Money-তে পেস্ট করুন'
      : `কপি হয়নি — নম্বরটি নিজে লিখুন: ${review.payout.accountNumber}`)
  }

  /** Fill the TrxID field from the clipboard (bKash success screen → copy → return). */
  async function pasteTrxId() {
    const raw = ((await readClipboardText()) || '').trim()
    const extracted = extractTrxIdFromText(raw)
    // Guard the fallback: never accept a pure number (that's the recipient's phone
    // number we copied on the way out, or an amount) as a transaction id.
    const fallback = /^[A-Za-z0-9-]{6,30}$/.test(raw) && !/^\d+$/.test(raw) ? raw : ''
    const trx = extracted || fallback
    if (!trx) {
      toast.error('ক্লিপবোর্ডে TrxID পাওয়া যায়নি — বিকাশের সফল স্ক্রিন থেকে TrxID কপি করুন')
      return
    }
    setReview(r => (r ? { ...r, transactionId: trx } : r))
  }

  /** Close the review sheet; a half-done bKash confirmation is cleared so it stops re-opening. */
  function dismissReview() {
    if (review) {
      const pending = readBkashSendPending()
      if (pending?.requestId === review.id) {
        clearBkashSendPending()
        toast('বিকাশ নিশ্চিতকরণ বাতিল হলো — পরে তালিকা থেকে "অনুমোদন" চেপে TrxID দিতে পারবেন', { icon: 'ℹ️' })
      }
    }
    setReview(null)
  }

  async function submitReview() {
    if (!review || reviewBusy) return
    const approvedAmount = review.action === 'APPROVE'
      ? roundMoney(Number(review.approvedAmount || review.requestedAmount))
      : undefined
    if (review.action === 'APPROVE' && (!approvedAmount || approvedAmount <= 0)) {
      toast.error('Enter a valid approved amount')
      return
    }
    const transactionId = review.transactionId.trim()
    if (review.action === 'APPROVE' && review.type === 'WITHDRAWAL' && !review.paidVia) {
      toast.error('কীভাবে টাকা দিলেন — ক্যাশ/বিকাশ/নগদ/ব্যাংক বাছাই করুন')
      return
    }
    if (review.action === 'APPROVE' && review.type === 'WITHDRAWAL' && review.paidVia !== 'CASH' && !transactionId) {
      toast.error('Transaction ID দিন (staff-কে SMS-এ পাঠানো হবে)')
      return
    }
    setReviewBusy(true)
    try {
      const result = await safeFetchJsonWithToast(`/api/payroll/wallet/requests/${review.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: review.action, approvedAmount, note: '', transactionId, paid_via: review.paidVia || undefined }),
      })
      if (!result.ok) {
        // The request is gone (approved elsewhere / already resolved) — drop the
        // half-done bKash confirmation so the sheet stops re-opening on resume.
        if (result.error.code === 'request_not_found') {
          const pending = readBkashSendPending()
          if (pending?.requestId === review.id) {
            clearBkashSendPending()
            setReview(null)
            void loadWallets(true)
          }
        }
        return
      }
      const pending = readBkashSendPending()
      if (pending?.requestId === review.id) clearBkashSendPending()
      toast.success(review.action === 'APPROVE' ? 'Approved · wallet ledger updated' : 'Rejected')
      setReview(null)
      void loadWallets(true)
    } finally {
      setReviewBusy(false)
    }
  }

  async function recoverAdvance(employeeId: string) {
    const result = await safeFetchJsonWithToast<{ recovered: number; remaining: number }>('/api/payroll/wallet/advance-recovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: employeeId, business_id: business.id }),
    })
    if (!result.ok) return
    toast.success(`৳ ${result.data.recovered.toLocaleString('en-BD')} অগ্রিম কাটা হয়েছে${result.data.remaining > 0 ? ` · বাকি ৳ ${result.data.remaining.toLocaleString('en-BD')}` : ' · সম্পূর্ণ পরিশোধ'}`)
    void loadWallets(true)
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

  async function toggleBusinessHold(businessId: string) {
    const current = automation?.heldBusinessIds ?? []
    const next = current.includes(businessId) ? current.filter(b => b !== businessId) : [...current, businessId]
    const result = await safeFetchJsonWithToast<{ setting: NonNullable<typeof automation> }>('/api/payroll/wallet/automation', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ heldBusinessIds: next }),
    })
    if (!result.ok) return
    setAutomation(result.data.setting)
    toast.success(next.includes(businessId) ? 'বিজনেস হোল্ডে — অটো/ম্যানুয়াল কোনো বেতন-রান চলবে না' : 'হোল্ড তোলা হয়েছে — বেতন-রান আবার চলবে')
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
    const amount = roundMoney(Number(compForm.amount))
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

  // ── Hero / KPI derived state ─────────────────────────────────────────────
  const cyclePeriodYm = useMemo(() => currentCyclePeriodYm(), [])
  const cycleLabel = periodYmBn(cyclePeriodYm)
  const calendarYm = useMemo(() => currentCalendarYm(), [])

  const totalEmployees = compWallets.length
  const paidEmployees = compWallets.filter(w => (w.summary?.currentCycleSalaryAdded ?? 0) > 0 && !(w.summary?.salaryDueMonths ?? []).length).length
  // Zero-salary rows (test/legacy employees) can't owe salary — keep the due list real.
  const dueWallets = compWallets.filter(w => (w.summary?.salaryDueMonths ?? []).length > 0 && (w.monthlySalary ?? 0) > 0)
  const unpaidEmployees = dueWallets.length
  const totalDueAmount = dueWallets.reduce((sum, w) => sum + (w.summary?.salaryDueMonths?.length ?? 0) * (w.monthlySalary ?? 0), 0)
  const givenThisCycle = compWallets.reduce((sum, w) => sum + (w.summary?.currentCycleSalaryAdded ?? 0), 0)
  const monthlyBudget = k?.total_monthly_salary ?? 0
  const pendingCount = walletData?.pendingRequests.length ?? 0

  const penaltyEntriesThisMonth = useMemo(() => {
    const wallets = walletData?.wallets ?? []
    const list: Array<{ key: string; name: string; employeeId: string; amount: number; date: string; note?: string | null }> = []
    for (const w of wallets) {
      for (const e of w.latestEntries) {
        if (e.type === 'PENALTY' && typeof e.date === 'string' && e.date.slice(0, 7) === calendarYm) {
          list.push({
            key: `${w.employeeId}:${e.id ?? e.date}`,
            name: w.name,
            employeeId: w.employeeId,
            amount: Math.abs(e.signedAmount),
            date: e.date,
            note: e.note,
          })
        }
      }
    }
    return list.sort((a, b) => b.date.localeCompare(a.date))
  }, [walletData, calendarYm])
  const penaltiesThisMonthTotal = penaltyEntriesThisMonth.reduce((s, e) => s + e.amount, 0)

  const historyGroups = useMemo(() => {
    const map = new Map<string, typeof history>()
    for (const run of history) {
      const key = run.periodYm || '—'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(run)
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]))
  }, [history])

  function reviewLedgerTable() {
    setLedgerTypeFilter('ALL')
    setEmployeeFilter('')
    setActiveTab('month')
    setPendingScrollToLedger(true)
  }

  useEffect(() => {
    if (activeTab === 'month' && pendingScrollToLedger) {
      const t = setTimeout(() => {
        document.getElementById('payroll-wallet-table')?.scrollIntoView({ behavior: 'smooth' })
        setPendingScrollToLedger(false)
      }, 50)
      return () => clearTimeout(t)
    }
  }, [activeTab, pendingScrollToLedger])

  const TABS: Array<{ key: TabKey; label: string; badge?: number }> = [
    { key: 'month', label: 'এই মাস' },
    { key: 'history', label: 'হিস্টরি' },
    { key: 'requests', label: 'সমন্বয় ও আপিল', badge: pendingCount || undefined },
    { key: 'tools', label: 'টুলস' },
  ]

  return (
    <FinancePageChrome
      title="বেতন"
      subtitle="মাসিক বেতন · কমিশন · বোনাস"
      actions={
        <div className="flex items-center gap-2">
          <Link href="/employees"><Button size="xs" variant="secondary">কর্মচারী</Button></Link>
          <BusinessSwitcherCompact />
        </div>
      }
    >
      <PageEnter className="min-w-0 max-w-full space-y-5">
      {walletError && showApprovals && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border tone-red px-4 py-3 text-sm">
          <span>{walletError}</span>
          <Button variant="ghost" size="xs" onClick={() => void loadWallets(true)}>আবার চেষ্টা করুন</Button>
        </div>
      )}

      {/* HERO: current cycle card */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-lg font-bold text-cream">{cycleLabel ? `${cycleLabel} চক্র` : 'চলতি চক্র'}</p>
            <p className="mt-1 text-[11px] text-muted">
              নিয়ম: আগের মাসের বেতন, প্রতি {toBnDigits(automation?.dayOfMonth ?? 10)} তারিখে
            </p>
          </div>
          <div className="text-right">
            <p className="text-[9px] font-bold uppercase tracking-wider text-muted">পেয়েছে</p>
            <p className="font-mono text-sm font-bold tabular-nums text-cream">
              {toBnDigits(paidEmployees)}/{toBnDigits(totalEmployees)} জন
            </p>
          </div>
        </div>
        <Progress value={paidEmployees} max={Math.max(totalEmployees, 1)} className="mt-4" />

        <div className="mt-5 grid grid-cols-2 overflow-hidden rounded-2xl border border-white/[0.06] divide-x divide-y sm:grid-cols-5 sm:divide-y-0 divide-white/[0.06]">
          <HeroKpiTile label="মাসিক বাজেট" value={monthlyBudget} loading={loading} />
          <HeroKpiTile label="দেওয়া হয়েছে" value={givenThisCycle} tone="pos" loading={walletLoading} />
          <HeroKpiTile label="বাকি (সব মাস)" value={totalDueAmount} tone={totalDueAmount > 0 ? 'amber' : 'pos'} loading={walletLoading} />
          <HeroKpiTile label="জরিমানা (এ মাস)" value={penaltiesThisMonthTotal} tone="neg" loading={walletLoading} />
          <HeroKpiTile label="অনুরোধ" value={pendingCount} isCount loading={walletLoading} />
        </div>
      </Card>

      {/* TABS */}
      <div className="flex gap-1 overflow-x-auto border-b border-white/[0.06] scrollbar-hide">
        {TABS.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            className={cn(
              'relative flex shrink-0 items-center gap-1.5 px-4 py-2.5 text-[12px] font-bold transition-colors',
              activeTab === t.key ? 'text-gold' : 'text-muted hover:text-cream',
            )}
          >
            {t.label}
            {!!t.badge && (
              <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-gold/15 px-1 text-[9px] font-black text-gold">
                {toBnDigits(t.badge)}
              </span>
            )}
            {activeTab === t.key && <span className="absolute inset-x-3 -bottom-px h-[2px] rounded-full bg-gold" />}
          </button>
        ))}
      </div>

      {/* ── এই মাস ─────────────────────────────────────────────────────── */}
      {activeTab === 'month' && (
        showApprovals ? (
          <div className="space-y-4">
            {unpaidEmployees > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border tone-amber px-4 py-3 text-[11px]">
                <span className="min-w-0">
                  {toBnDigits(unpaidEmployees)} জনের বেতন বাকি — মোট ৳ {totalDueAmount.toLocaleString('en-BD')}:{' '}
                  <b className="font-semibold">
                    {dueWallets
                      .map(w => `${w.name} (${(w.summary?.salaryDueMonths ?? []).map(m => periodYmBn(m) ?? m).join(', ')})`)
                      .join(' · ')}
                  </b>
                </span>
                <Button size="xs" variant="gold" onClick={() => void runAccrual()}>বেতন চালান</Button>
              </div>
            )}

            <Card className="overflow-hidden p-0">
              {walletLoading ? (
                <div className="p-5"><Skeleton className="h-40 w-full" /></div>
              ) : !compWallets.length ? (
                <div className="p-5"><Empty icon="◈" title="এই ব্যবসায় কোনো কর্মচারী যুক্ত নেই" desc="স্টাফদের HR employee ID ও ব্যবসা-অ্যাক্সেস দিন।" /></div>
              ) : (
                <div className="divide-y divide-white/[0.05]">
                  {compWallets.map(w => {
                    const paidAmt = w.summary?.currentCycleSalaryAdded ?? 0
                    const due = w.summary?.salaryDueMonths ?? []
                    const paid = paidAmt > 0 && due.length === 0
                    const dueLabel = due.map(m => periodYmBn(m) ?? m).join(', ')
                    const dueAmount = due.length * (w.monthlySalary ?? 0)
                    const advanceDue = w.summary?.outstandingAdvance ?? 0
                    const walletBalance = w.summary?.currentBalance ?? 0
                    return (
                      <div key={`${w.businessId}:${w.employeeId}`} className="flex items-center gap-3 px-4 py-3">
                        <Avatar name={w.name} size="sm" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-semibold text-cream">{w.name}</p>
                          <p className="mt-0.5 truncate font-mono text-[10px] text-muted">{w.employeeId}</p>
                          {advanceDue > 0 && (
                            <span className="mt-1 inline-flex items-center gap-2 text-[10px] font-semibold text-red-400">
                              অগ্রিম বকেয়া ৳ {advanceDue.toLocaleString('en-BD')}
                              {walletBalance > 0 && (
                                <button
                                  type="button"
                                  className="rounded-full border border-red-400/50 px-2 py-0.5 text-[10px] font-bold text-red-400 hover:bg-red-400 hover:text-white"
                                  onClick={() => {
                                    if (window.confirm(`${w.name} — ওয়ালেট ব্যালেন্স থেকে অগ্রিম বকেয়া (সর্বোচ্চ ৳ ${Math.min(advanceDue, walletBalance).toLocaleString('en-BD')}) কেটে নেবেন?`)) {
                                      void recoverAdvance(w.employeeId)
                                    }
                                  }}
                                >
                                  এখনই কাটুন
                                </button>
                              )}
                            </span>
                          )}
                        </div>
                        <div className="flex min-w-0 shrink items-center gap-1.5">
                          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', paid ? 'bg-emerald-400' : 'bg-amber-500')} />
                          <span className={cn('truncate text-[10px] font-semibold', paid ? 'txt-pos' : 'text-amber-500')}>
                            {paid ? 'পেয়েছে' : `বাকি — ${dueLabel}`}
                          </span>
                        </div>
                        <span className="w-24 shrink-0 text-right font-mono text-[12px] font-bold tabular-nums text-cream">
                          ৳ {(paid ? paidAmt : dueAmount).toLocaleString('en-BD')}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </Card>

            {/* Detailed wallet ledger — preserved from the previous design */}
            <div id="payroll-wallet-table">
              <Card className="p-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm font-bold text-cream">বিস্তারিত ওয়ালেট লেজার</p>
                  <div className="relative min-w-[10rem] flex-1">
                    <svg className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    <input
                      value={employeeFilter}
                      onChange={e => setEmployeeFilter(e.target.value)}
                      placeholder="কর্মচারী খুঁজুন"
                      className="w-full min-h-[44px] rounded-xl border border-white/[0.06] bg-card/85 pl-9 pr-3 py-2 text-[11px] text-cream focus:outline-none focus:ring-2 focus:ring-gold/20 md:min-h-0"
                    />
                  </div>
                </div>
                <div className="mb-4 flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
                  {LEDGER_FILTER_TYPES.map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setLedgerTypeFilter(t)}
                      className={cn(
                        'shrink-0 min-h-[44px] rounded-full border px-3.5 py-2 text-xs font-bold transition-colors md:min-h-0 md:px-3 md:py-1.5',
                        ledgerTypeFilter === t
                          ? 'border-gold/30 bg-gold/10 text-gold'
                          : 'border-white/[0.06] text-muted hover:bg-white/[0.04] hover:text-cream',
                      )}
                    >
                      {t === 'ALL' ? 'সব' : (WALLET_TYPE_LABEL_BN[t] ?? t.replace(/_/g, ' '))}
                    </button>
                  ))}
                </div>
                {walletLoading ? <Skeleton className="h-40" /> : !(walletData?.wallets ?? []).length ? (
                  <Empty
                    icon="◈"
                    title="এখনো কোনো লেজার নেই"
                    desc="বেতন চালান অথবা অনুরোধ অনুমোদন করলে লেজার এন্ট্রি তৈরি হবে।"
                    action={showApprovals ? <Button variant="gold" size="sm" onClick={() => void runAccrual()}>বেতন চালান</Button> : undefined}
                  />
                ) : (
                  <>
                  <div className="hidden min-w-0 max-w-full max-h-[480px] overflow-x-auto md:block">
                    <table className="w-full min-w-[1080px] text-left text-[11px]">
                      <thead className="sticky top-0 z-[1] border-b border-white/[0.06] bg-card/88 text-xs uppercase tracking-wider text-muted backdrop-blur-sm">
                        <tr>
                          <th className="py-3 pr-3 font-medium">কর্মচারী</th>
                          <th className="py-3 pr-3 text-right font-medium">মোট আয়</th>
                          <th className="py-3 pr-3 text-right font-medium">কমিশন</th>
                          <th className="py-3 pr-3 text-right font-medium">বোনাস</th>
                          <th className="py-3 pr-3 text-right font-medium">কর্তন</th>
                          <th className="py-3 pr-3 text-right font-medium">উত্তোলিত</th>
                          <th className="py-3 pr-3 text-right font-medium">জমা ব্যালেন্স</th>
                          <th className="py-3 pr-3 text-right font-medium">ভ্যারিয়েবল %</th>
                          <th className="py-3 font-medium" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.04]">
                        {filteredWallets.map((w: PayrollWallet) => (
                          <tr key={`${w.businessId}:${w.employeeId}`} className="transition-colors hover:bg-white/[0.04]/80">
                            <td className="py-3 pr-3"><span className="font-medium text-cream">{w.name}</span><span className="block font-mono text-[10px] text-muted">{w.employeeId}</span></td>
                            <td className="py-3 pr-3 text-right font-mono text-cream">৳ {w.summary.lifetimeEarned.toLocaleString('en-BD')}</td>
                            <td className="py-3 pr-3 text-right font-mono txt-pos">৳ {w.summary.totalCommissions.toLocaleString('en-BD')}</td>
                            <td className="py-3 pr-3 text-right font-mono text-gold">৳ {w.summary.totalBonuses.toLocaleString('en-BD')}</td>
                            <td className="py-3 pr-3 text-right font-mono txt-neg">৳ {(w.summary.totalMealDeductions + w.summary.totalPenalties).toLocaleString('en-BD')}</td>
                            <td className="py-3 pr-3 text-right font-mono text-muted">৳ {w.summary.lifetimeWithdrawn.toLocaleString('en-BD')}</td>
                            <td className="py-3 pr-3 text-right font-mono font-medium txt-pos">৳ {w.summary.companyLiability.toLocaleString('en-BD')}</td>
                            <td className="py-3 pr-3 text-right font-mono text-muted">{w.summary.totalAccrued ? `${Math.round(((w.summary.totalCommissions + w.summary.totalBonuses) / w.summary.totalAccrued) * 100)}%` : '—'}</td>
                            <td className="py-3"><Link href={`/employees/${encodeURIComponent(w.employeeId)}`} className="font-medium text-gold hover:text-gold">লেজার</Link></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile Expandable Cards */}
                  <motion.div className="space-y-3 md:hidden" variants={_stagger} initial="hidden" animate="show">
                    {filteredWallets.slice(0, 80).map((w: PayrollWallet) => (
                      <motion.div key={`${w.businessId}:${w.employeeId}`} variants={_fadeUp}>
                        <Card interactive className="p-4 text-[11px]">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate font-semibold text-cream">{w.name}</p>
                              <p className="font-mono text-[10px] text-muted">{w.employeeId}</p>
                            </div>
                            <Link href={`/employees/${encodeURIComponent(w.employeeId)}`} className="shrink-0 text-xs font-medium text-gold">
                              লেজার →
                            </Link>
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <div className="rounded-xl border border-white/[0.06] bg-white/[0.04]/50 px-3 py-2">
                              <p className="text-[10px] text-muted">মোট আয়</p>
                              <p className="font-mono font-bold text-cream">৳ {w.summary.lifetimeEarned.toLocaleString('en-BD')}</p>
                            </div>
                            <div className="rounded-xl border border-white/[0.06] bg-emerald-500/10 px-3 py-2">
                              <p className="text-[10px] text-muted">জমা ব্যালেন্স</p>
                              <p className="font-mono font-bold txt-pos">৳ {w.summary.companyLiability.toLocaleString('en-BD')}</p>
                            </div>
                            <div className="rounded-xl border border-white/[0.06] bg-white/[0.04]/50 px-3 py-2">
                              <p className="text-[10px] text-muted">কমিশন</p>
                              <p className="font-mono txt-pos">৳ {w.summary.totalCommissions.toLocaleString('en-BD')}</p>
                            </div>
                            <div className="rounded-xl border border-white/[0.06] bg-red-500/10 px-3 py-2">
                              <p className="text-[10px] text-muted">কর্তন</p>
                              <p className="font-mono txt-neg">৳ {(w.summary.totalMealDeductions + w.summary.totalPenalties).toLocaleString('en-BD')}</p>
                            </div>
                          </div>
                        </Card>
                      </motion.div>
                    ))}
                  </motion.div>
                  </>
                )}
              </Card>
            </div>
          </div>
        ) : (
          <Card className="p-5"><Empty icon="◈" title="এই সেকশন দেখার অনুমতি নেই" /></Card>
        )
      )}

      {/* ── হিস্টরি ─────────────────────────────────────────────────────── */}
      {activeTab === 'history' && (
        <div className="space-y-4">
          <Card className="p-5">
            <p className="mb-4 text-sm font-bold text-cream">বেতন চালান হিস্টরি</p>
            {!historyGroups.length ? (
              <Empty icon="◇" title="এখনো কোনো accrual রান নেই" />
            ) : (
              <div className="space-y-2">
                {historyGroups.map(([periodYm, runs]) => {
                  const totalCreated = runs.reduce((s, r) => s + r.createdCount, 0)
                  const totalSkipped = runs.reduce((s, r) => s + r.skippedCount, 0)
                  return (
                    <details key={periodYm} className="group overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.04]/40">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                        <span className="text-[12px] font-bold text-cream">{periodYmBn(periodYm) ?? periodYm}</span>
                        <span className="flex items-center gap-3 text-[11px] text-muted">
                          <span>{toBnDigits(totalCreated)} জমা{totalSkipped ? ` · ${toBnDigits(totalSkipped)} স্কিপ` : ''}</span>
                          <svg className="h-3.5 w-3.5 transition-transform group-open:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </span>
                      </summary>
                      <div className="divide-y divide-white/[0.04] border-t border-white/[0.05] px-4">
                        {runs.map(run => (
                          <div key={run.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[11px]">
                            <span className="text-muted">{dateBn(run.createdAt)} · {run.trigger === 'AUTO' ? 'স্বয়ংক্রিয়' : 'ম্যানুয়াল'}</span>
                            <span className={run.status === 'SUCCESS' ? 'txt-pos font-semibold' : run.status === 'RUNNING' ? 'font-semibold text-amber-500' : 'txt-neg font-semibold'}>
                              {run.status === 'SUCCESS' ? 'সফল' : run.status === 'RUNNING' ? 'চলছে' : 'ব্যর্থ'}
                            </span>
                            <span className="font-mono text-gold">+{toBnDigits(run.createdCount)} / স্কিপ {toBnDigits(run.skippedCount)}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )
                })}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <p className="mb-4 text-sm font-bold text-cream">পুরাতন হিসাব (লিগ্যাসি)</p>
            {loading ? <Skeleton className="h-40" /> : roll.length === 0 ? (
              <Empty icon="⌁" title="সক্রিয় পেরোল নেই" desc="কর্মচারী যোগ করে অ্যাডভান্স বা বেতন লগ করুন।" />
            ) : (
              <div className="min-w-0 max-w-full max-h-[480px] overflow-x-auto">
                <table className="w-full min-w-[980px] text-left text-[11px]">
                  <thead className="sticky top-0 z-[1] border-b border-white/[0.06] bg-card/88 text-xs uppercase tracking-wider text-muted backdrop-blur-sm">
                    <tr>
                      <th className="py-3 pr-3 font-medium">কর্মচারী</th>
                      <th className="py-3 pr-3 text-right font-medium">বেতন</th>
                      <th className="py-3 pr-3 text-right font-medium">প্রদত্ত</th>
                      <th className="py-3 pr-3 text-right font-medium">অ্যাডভান্স</th>
                      <th className="py-3 pr-3 text-right font-medium">বাকি</th>
                      <th className="py-3 font-medium" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {roll.map(r => (
                      <tr key={r.emp_id} className="transition-colors hover:bg-white/[0.04]/50">
                        <td className="py-3 pr-3 font-medium text-cream">{r.name}</td>
                        <td className="py-3 pr-3 text-right font-mono text-cream">৳ {r.monthly_salary.toLocaleString('en-BD')}</td>
                        <td className="py-3 pr-3 text-right font-mono text-muted">৳ {r.salary_paid.toLocaleString('en-BD')}</td>
                        <td className="py-3 pr-3 text-right font-mono text-muted">৳ {Math.max(0, r.advance_balance).toLocaleString('en-BD')}</td>
                        <td className="py-3 pr-3 text-right font-mono font-medium text-gold">৳ {Math.max(0, r.current_due).toLocaleString('en-BD')}</td>
                        <td className="py-3"><Link href={`/employees/${r.emp_id}`} className="font-medium text-gold hover:text-gold">বিস্তারিত</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="overflow-hidden p-5">
            <p className="mb-3 text-sm font-bold text-cream">সাম্প্রতিক টাইমলাইন</p>
            {loading ? <Skeleton className="h-28" /> : !(data?.payroll_timeline ?? []).length ? (
              <p className="text-xs text-muted">কর্মচারী ডিটেইল স্ক্রিন থেকে অ্যাডভান্স বা পেআউট রেকর্ড করুন।</p>
            ) : (
              <div className="max-h-64 divide-y divide-white/[0.04] overflow-y-auto text-[11px]">
                {(data!.payroll_timeline ?? []).map(tx => (
                  <div key={tx.tx_id} className="flex items-center justify-between gap-2 py-2.5">
                    <span className="font-mono text-[10px] text-muted">{tx.date.slice(0, 10)}</span>
                    <span className="flex-1 font-medium text-cream">{tx.emp_name} · {tx.tx_type.replace('_', ' ')}</span>
                    <span className="font-mono font-bold text-gold">৳ {tx.amount.toLocaleString('en-BD')}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ── সমন্বয় ও আপিল ──────────────────────────────────────────────── */}
      {activeTab === 'requests' && (
        showApprovals ? (
          <div className="space-y-4">
            <Card className="border-amber-100 p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-bold text-cream">উত্তোলন অনুরোধ</p>
                <Button size="xs" variant="secondary" type="button" onClick={() => void loadWallets()}>রিফ্রেশ</Button>
              </div>
              {walletLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : !(walletData?.pendingRequests ?? []).length ? (
                <Empty icon="◆" title="কোনো পেন্ডিং অনুরোধ নেই" desc="অ্যাডভান্স ও উত্তোলনের অনুরোধ এখানে দেখা যাবে।" />
              ) : (
                <div className="space-y-2 overflow-x-auto">
                  {walletData!.pendingRequests.map(req => (
                    <div key={req.id} className="flex flex-col gap-3 rounded-2xl border border-white/[0.06] p-4 text-[11px] transition-colors hover:bg-white/[0.04]/50 sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-cream">{WALLET_TYPE_LABEL_BN[req.type] ?? req.type.replace(/_/g, ' ')} · {req.employeeId}</p>
                        <p className="mt-1 text-muted">{req.reason.slice(0, 160)}{req.reason.length > 160 ? '…' : ''}</p>
                        <p className="mt-1 text-[10px] text-muted">{req.businessId.replace(/_/g, ' ')} · {req.createdAt.slice(0, 10)}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="font-mono text-sm font-bold text-gold">৳ {Number(req.requestedAmount).toLocaleString('en-BD')}</span>
                        <Button size="xs" variant="secondary" type="button" onClick={() => setReview({ id: req.id, action: 'REJECT', type: req.type, requestedAmount: Number(req.requestedAmount), approvedAmount: String(req.requestedAmount), transactionId: '', paidVia: '', employeeId: req.employeeId, businessId: req.businessId, payout: req.payout ?? null })}>প্রত্যাখ্যান</Button>
                        <Button size="xs" variant="gold" type="button" onClick={() => setReview({ id: req.id, action: 'APPROVE', type: req.type, requestedAmount: Number(req.requestedAmount), approvedAmount: String(req.requestedAmount), transactionId: '', paidVia: '', employeeId: req.employeeId, businessId: req.businessId, payout: req.payout ?? null })}>অনুমোদন</Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-5">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-cream">ম্যানুয়াল এন্ট্রি</p>
                  <p className="mt-1 text-[11px] text-muted">বেতন ক্রেডিট, বোনাস, কমিশন, ওভারটাইম, রিইমবার্সমেন্ট, কর্তন, জরিমানা বা সমন্বয় লেজারে পোস্ট করুন।</p>
                </div>
              </div>
              <form onSubmit={submitCompensation} className="grid gap-2 text-[11px] md:grid-cols-[1.2fr_1fr_1fr_1fr_1.5fr_auto]">
                <select value={compForm.employeeId} onChange={e => setCompForm(f => ({ ...f, employeeId: e.target.value }))} className="rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2.5 text-cream focus:outline-none focus:ring-2 focus:ring-gold/20">
                  <option value="">কর্মচারী বাছুন</option>
                  {compWallets.map(w => <option key={`${w.businessId}:${w.employeeId}`} value={w.employeeId}>{w.name} · {w.employeeId}</option>)}
                </select>
                <select value={compForm.type} onChange={e => setCompForm(f => ({ ...f, type: e.target.value }))} className="rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2.5 text-cream focus:outline-none focus:ring-2 focus:ring-gold/20">
                  {PAYROLL_COMPENSATION_TYPES.map(t => (
                    <option key={t.value} value={t.value}>
                      {WALLET_TYPE_LABEL_BN[t.value] ?? t.value}{t.kind === 'credit' ? ' · জমা' : t.kind === 'debit' ? ' · কর্তন' : ''}
                    </option>
                  ))}
                </select>
                <input value={compForm.amount} onChange={e => setCompForm(f => ({ ...f, amount: e.target.value }))} type="number" min={compForm.type === 'ADJUSTMENT' ? undefined : 1} step="1" placeholder={compForm.type === 'ADJUSTMENT' ? 'পরিমাণ (+/-)' : 'পরিমাণ'} className="rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2.5 font-mono text-cream focus:outline-none focus:ring-2 focus:ring-gold/20" />
                <input value={compForm.date} onChange={e => setCompForm(f => ({ ...f, date: e.target.value }))} type="date" className="rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2.5 text-cream focus:outline-none focus:ring-2 focus:ring-gold/20" />
                <input value={compForm.note} onChange={e => setCompForm(f => ({ ...f, note: e.target.value }))} placeholder="নোট" className="rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2.5 text-cream focus:outline-none focus:ring-2 focus:ring-gold/20" />
                <Button size="xs" variant="gold" type="submit" loading={compBusy}>পোস্ট</Button>
              </form>
              {orphanLedgerCount > 0 && (
                <p className="mt-3 rounded-xl border px-3 py-2 text-[11px] tone-amber">
                  {toBnDigits(orphanLedgerCount)}টি লেজার এন্ট্রি রোস্টার/ইউজারের সাথে যুক্ত নেই।{' '}
                  <button type="button" className="font-medium text-gold underline" onClick={reviewLedgerTable}>
                    লেজারে দেখুন
                  </button>
                </p>
              )}
            </Card>

            <Card className="p-5">
              <p className="mb-3 text-sm font-bold text-cream">এই মাসের জরিমানা</p>
              {!penaltyEntriesThisMonth.length ? (
                <Empty icon="◇" title="এই মাসে কোনো জরিমানা নেই" />
              ) : (
                <div className="divide-y divide-white/[0.04] text-[11px]">
                  {penaltyEntriesThisMonth.map(entry => (
                    <div key={entry.key} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                      <div className="min-w-0">
                        <p className="font-medium text-cream">{entry.name} <span className="font-mono text-[10px] text-muted">{entry.employeeId}</span></p>
                        <p className="text-[10px] text-muted">{dateBn(entry.date)}{entry.note ? ` · ${entry.note}` : ''}</p>
                      </div>
                      <span className="font-mono font-bold txt-neg">৳ {entry.amount.toLocaleString('en-BD')}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        ) : (
          <Card className="p-5"><Empty icon="◈" title="এই সেকশন দেখার অনুমতি নেই" /></Card>
        )
      )}

      {/* ── টুলস ────────────────────────────────────────────────────────── */}
      {activeTab === 'tools' && (
        showApprovals ? (
          <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-bold text-cream">অটো-বেতন</p>
                    <p className="mt-1 text-[11px] text-muted">
                      প্রতি মাসের {toBnDigits(automation?.dayOfMonth ?? 10)} তারিখে চলে · আগের মাসের বেতন ক্রেডিট করে · {automation?.timezone ?? 'Asia/Dhaka'}
                    </p>
                    <p className="mt-2 text-[11px] text-muted">
                      প্রিভিউ: <span className="font-mono font-bold text-gold">৳ {Number(preview?.totalPreviewSalary ?? 0).toLocaleString('en-BD')}</span>
                      {' '}({toBnDigits(preview?.employees.length ?? 0)} জন যুক্ত · {toBnDigits(preview?.alreadyAccruedCount ?? 0)} জন হয়ে গেছে)
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="xs" variant={automation?.enabled ? 'secondary' : 'gold'} onClick={() => void toggleAutomation(!automation?.enabled)}>
                      {automation?.enabled ? 'বন্ধ করুন' : 'চালু করুন'}
                    </Button>
                    <Button size="xs" variant="gold" onClick={() => void runAccrual()}>এখনই চালান</Button>
                  </div>
                </div>
                <div className="mt-4 border-t border-white/[0.06] pt-3">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-muted">বিজনেস-ধরে হোল্ড</p>
                  <p className="mt-1 text-[10px] text-muted">হোল্ডে থাকা বিজনেসে অটো বা ম্যানুয়াল — কোনো বেতন-রানই চলবে না।</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {([['ALMA_LIFESTYLE', 'Alma Lifestyle'], ['ALMA_TRADING', 'Alma Trading'], ['CREATIVE_DIGITAL_IT', 'CDIT']] as const).map(([id, label]) => {
                      const heldNow = (automation?.heldBusinessIds ?? []).includes(id)
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => void toggleBusinessHold(id)}
                          className={`rounded-full border px-3.5 py-1.5 text-[11px] font-bold transition ${heldNow ? 'border-red-400/60 bg-red-400/15 text-red-400' : 'border-white/[0.1] bg-card/85 text-muted hover:border-gold/40'}`}
                        >
                          {label}{heldNow ? ' · হোল্ডে' : ''}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </Card>

              <Card className="p-5">
                <p className="text-sm font-bold text-cream">এক্সপোর্ট</p>
                <p className="mt-1 text-[11px] text-muted">বর্তমান ওয়ালেট লেজার ডাউনলোড করুন।</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" disabled={!walletData?.wallets.length} onClick={() => void exportPdf()}>PDF ডাউনলোড</Button>
                  <Button size="sm" variant="secondary" disabled={!walletData?.wallets.length} onClick={() => exportCsv()}>CSV ডাউনলোড</Button>
                  <Button size="sm" variant="secondary" disabled={!walletData?.wallets.length} onClick={() => void exportXlsx()}>Excel ডাউনলোড</Button>
                </div>
              </Card>
            </div>

            <Card className="p-5">
              <p className="text-sm font-bold text-cream">মিল-ভাতা</p>
              <p className="mt-1 max-w-2xl text-[11px] text-muted">
                নির্দিষ্ট কর্মচারীর জন্য মিল-ভাতা চালু করুন। যেদিন রান্না হয় না, সেদিন চালু থাকা কর্মচারীরা ভাতা অনুরোধ করতে পারবেন।
              </p>
              {mealLoading ? (
                <Skeleton className="mt-4 h-40" />
              ) : !mealRows.length ? (
                <div className="mt-4">
                  <Empty icon="◷" title="এই ব্যবসায় কোনো কর্মচারী যুক্ত নেই" desc="স্টাফদের HR employee ID ও ব্যবসা-অ্যাক্সেস দিন।" />
                </div>
              ) : (
                <>
                <div className="table-scroll mt-4 hidden min-w-0 max-w-full max-h-[420px] overflow-x-auto md:block">
                  <table className="w-full min-w-[720px] text-left text-[11px]">
                    <thead className="sticky top-0 z-[1] border-b border-white/[0.06] bg-card/88 text-xs uppercase tracking-wider text-muted backdrop-blur-sm">
                      <tr>
                        <th className="py-3 pr-3 font-medium">কর্মচারী</th>
                        <th className="py-3 pr-3 font-medium">ফোন</th>
                        <th className="py-3 pr-3 text-center font-medium">চালু</th>
                        <th className="py-3 pr-3 text-right font-medium">পরিমাণ (৳)</th>
                        <th className="py-3 font-medium" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04]">
                      {mealRows.map(row => (
                        <tr key={row.userId} className="transition-colors hover:bg-white/[0.04]/50">
                          <td className="py-3 pr-3">
                            <span className="font-medium text-cream">{row.name}</span>
                            <span className="block font-mono text-[10px] text-muted">{row.employeeId || '—'}</span>
                          </td>
                          <td className="py-3 pr-3 text-muted">{row.phone || '—'}</td>
                          <td className="py-3 pr-3 text-center">
                            <input
                              type="checkbox"
                              checked={row.enabled}
                              onChange={e =>
                                setMealRows(prev =>
                                  prev.map(r => (r.userId === row.userId ? { ...r, enabled: e.target.checked } : r)),
                                )
                              }
                              className="h-4 w-4 rounded border-white/[0.1] accent-gold"
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
                              className="ml-auto w-full max-w-[120px] rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2 text-right font-mono text-cream focus:outline-none focus:ring-2 focus:ring-gold/20 disabled:opacity-40"
                            />
                          </td>
                          <td className="py-3 text-right">
                            <Button
                              size="xs"
                              variant="secondary"
                              disabled={row.saving || (row.enabled && (!row.amountBdt || Number(row.amountBdt) <= 0))}
                              onClick={() => void saveMealProfile(row)}
                            >
                              {row.saving ? 'সংরক্ষণ হচ্ছে…' : 'সংরক্ষণ'}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile cards */}
                <motion.div className="mt-4 space-y-3 md:hidden" variants={_stagger} initial="hidden" animate="show">
                  {mealRows.map(row => (
                    <motion.div key={row.userId} variants={_fadeUp}>
                      <Card className="p-4 text-[11px]">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-cream">{row.name}</p>
                            <p className="font-mono text-[10px] text-muted">{row.employeeId || '—'}</p>
                            <p className="mt-0.5 text-[10px] text-muted">{row.phone || '—'}</p>
                          </div>
                          <label className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted">
                            চালু
                            <input
                              type="checkbox"
                              checked={row.enabled}
                              onChange={e =>
                                setMealRows(prev =>
                                  prev.map(r => (r.userId === row.userId ? { ...r, enabled: e.target.checked } : r)),
                                )
                              }
                              className="h-4 w-4 rounded border-white/[0.1] accent-gold"
                            />
                          </label>
                        </div>
                        <div className="mt-3 flex items-end justify-between gap-3">
                          <label className="flex-1">
                            <span className="mb-1 block text-[10px] text-muted">পরিমাণ (৳)</span>
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
                              className="min-h-[44px] w-full rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2 font-mono text-cream focus:outline-none focus:ring-2 focus:ring-gold/20 disabled:opacity-40"
                            />
                          </label>
                          <Button
                            size="xs"
                            variant="secondary"
                            disabled={row.saving || (row.enabled && (!row.amountBdt || Number(row.amountBdt) <= 0))}
                            onClick={() => void saveMealProfile(row)}
                          >
                            {row.saving ? 'সংরক্ষণ হচ্ছে…' : 'সংরক্ষণ'}
                          </Button>
                        </div>
                      </Card>
                    </motion.div>
                  ))}
                </motion.div>
                </>
              )}
            </Card>

            <Card className="p-5">
              <p className="text-sm font-bold text-cream">ড্রাইভিং মোড</p>
              <p className="mt-1 max-w-2xl text-[11px] text-muted">
                রাস্তায় বের হওয়া স্টাফদের জন্য ড্রাইভিং মোড চালু করুন। চালু থাকা স্টাফরা My Desk থেকে অনুরোধ করতে পারবে; অনুমোদনের পর এজেন্ট তাদের অফিস ফলো-আপ বন্ধ রাখবে যতক্ষণ না তারা ফিরে আসে।
              </p>
              {drivingLoading ? (
                <Skeleton className="mt-4 h-40" />
              ) : !drivingRows.length ? (
                <div className="mt-4">
                  <Empty icon="◷" title="এই ব্যবসায় কোনো কর্মচারী যুক্ত নেই" desc="স্টাফদের HR employee ID ও ব্যবসা-অ্যাক্সেস দিন।" />
                </div>
              ) : (
                <div className="mt-4 min-w-0 max-w-full max-h-[420px] overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-[11px]">
                    <thead className="sticky top-0 z-[1] border-b border-white/[0.06] bg-card/88 text-xs uppercase tracking-wider text-muted backdrop-blur-sm">
                      <tr>
                        <th className="py-3 pr-3 font-medium">কর্মচারী</th>
                        <th className="py-3 pr-3 font-medium">ফোন</th>
                        <th className="py-3 pr-3 text-center font-medium">চালু</th>
                        <th className="py-3 pr-3 text-center font-medium">স্ট্যাটাস</th>
                        <th className="py-3 font-medium" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04]">
                      {drivingRows.map(row => (
                        <tr key={row.userId} className="transition-colors hover:bg-white/[0.04]/50">
                          <td className="py-3 pr-3">
                            <span className="font-medium text-cream">{row.name}</span>
                            <span className="block font-mono text-[10px] text-muted">{row.employeeId || '—'}</span>
                          </td>
                          <td className="py-3 pr-3 text-muted">{row.phone || '—'}</td>
                          <td className="py-3 pr-3 text-center">
                            <input
                              type="checkbox"
                              checked={row.enabled}
                              onChange={e =>
                                setDrivingRows(prev =>
                                  prev.map(r => (r.userId === row.userId ? { ...r, enabled: e.target.checked } : r)),
                                )
                              }
                              className="h-4 w-4 rounded border-white/[0.1] accent-gold"
                            />
                          </td>
                          <td className="py-3 pr-3 text-center">
                            {row.drivingStatus === 'ACTIVE' ? (
                              <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-400">চলছে</span>
                            ) : row.drivingStatus === 'PENDING' ? (
                              <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-400">অপেক্ষমাণ</span>
                            ) : (
                              <span className="text-muted">—</span>
                            )}
                          </td>
                          <td className="py-3 text-right">
                            <div className="inline-flex items-center gap-2">
                              {row.enabled && row.drivingStatus !== 'PENDING' && (
                                <Button
                                  size="xs"
                                  variant={row.drivingStatus === 'ACTIVE' ? 'danger' : 'gold'}
                                  disabled={row.toggling}
                                  onClick={() => void toggleDrivingNow(row)}
                                >
                                  {row.toggling ? '…' : row.drivingStatus === 'ACTIVE' ? 'শেষ করুন' : 'শুরু করুন'}
                                </Button>
                              )}
                              <Button
                                size="xs"
                                variant="secondary"
                                disabled={row.saving}
                                onClick={() => void saveDrivingProfile(row)}
                              >
                                {row.saving ? 'সংরক্ষণ হচ্ছে…' : 'সংরক্ষণ'}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        ) : (
          <Card className="p-5"><Empty icon="◈" title="এই সেকশন দেখার অনুমতি নেই" /></Card>
        )
      )}

      {review && (
        <MobileModalPortal open zIndex={80} onBackdropClick={dismissReview}>
          <Card className="mobile-modal-shell w-full max-w-md border-gold/20 sm:rounded-2xl">
            <div className="mobile-modal-header p-5 pb-3">
              <p className="text-sm font-bold text-cream">
                {review.action === 'APPROVE' ? 'উত্তোলন অনুরোধ অনুমোদন' : 'উত্তোলন অনুরোধ প্রত্যাখ্যান'}
              </p>
              <p className="mt-1 text-xs text-muted">
                অনুরোধকৃত পরিমাণ: <span className="font-mono font-bold text-gold">৳ {review.requestedAmount.toLocaleString('en-BD')}</span>
              </p>
            </div>
            <div className="mobile-modal-body px-5">
              {review.action === 'APPROVE' && (
                <label className="block text-[11px] font-bold uppercase tracking-wider text-muted">
                  অনুমোদিত পরিমাণ
                  <input
                    autoFocus
                    inputMode="decimal"
                    type="number"
                    min="1"
                    value={review.approvedAmount}
                    onChange={e => setReview(r => r ? { ...r, approvedAmount: e.target.value } : r)}
                    className="mt-2 w-full rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2.5 text-sm text-cream outline-none focus:ring-2 focus:ring-gold/20"
                  />
                </label>
              )}
              {review.action === 'APPROVE' && (
                <div className="mt-3">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-muted">কীভাবে টাকা দিলেন</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {([['CASH', 'ক্যাশ'], ['BKASH', 'বিকাশ'], ['NAGAD', 'নগদ'], ['BANK', 'ব্যাংক']] as const).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setReview(r => r ? { ...r, paidVia: val } : r)}
                        className={`rounded-full border px-4 py-1.5 text-xs font-bold transition ${review.paidVia === val ? 'border-gold bg-gold text-white' : 'border-white/[0.1] bg-card/85 text-muted hover:border-gold/40'}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <span className="mt-1 block text-[10px] text-muted">লেনদেনের খাতায় লেখা থাকবে — সবাই দেখবে কীভাবে পেমেন্ট হয়েছে।</span>
                </div>
              )}
              {ownerBkashFlow && review.action === 'APPROVE' && review.type === 'WITHDRAWAL' && review.paidVia === 'BKASH'
                && review.payout?.provider === 'BKASH' && review.payout.accountNumber && review.payout.accountNumber !== '—' && (
                <div className="mt-3 rounded-xl border border-gold/25 bg-gold/[0.06] p-3">
                  <p className="text-[11px] font-bold text-cream">
                    {review.resumedFromBkash
                      ? 'বিকাশ থেকে ফিরেছেন — TrxID পেস্ট করে অনুমোদন শেষ করুন'
                      : `প্রাপকের বিকাশ${review.payout.accountHolder ? ` · ${review.payout.accountHolder}` : ''}`}
                  </p>
                  <p className="mt-1 font-mono text-sm font-bold text-gold">{review.payout.accountNumber}</p>
                  {!review.resumedFromBkash && (
                    <div className="mt-2">
                      {/* A real link, not a button: iOS opens a Universal Link most
                          reliably from an actual anchor tap. onClick only copies —
                          the browser does the navigation. */}
                      <a
                        href={BKASH_APP_URL}
                        onClick={() => startBkashSend()}
                        className="inline-flex items-center gap-1.5 rounded-full bg-gold px-4 py-2 text-xs font-bold text-white transition hover:bg-gold-dim"
                      >
                        নম্বর কপি করে বিকাশ খুলুন →
                      </a>
                    </div>
                  )}
                  <span className="mt-2 block text-[10px] text-muted">
                    {review.resumedFromBkash
                      ? 'বিকাশের সফল স্ক্রিন থেকে TrxID কপি করে নিচের "পেস্ট" বাটন চাপুন।'
                      : 'টাকা পাঠিয়ে অ্যাপে ফিরে এলে এই ঘরটাই আবার খুলবে — তখন TrxID পেস্ট করলেই শেষ।'}
                  </span>
                </div>
              )}
              {review.action === 'APPROVE' && review.type === 'WITHDRAWAL' && review.paidVia !== 'CASH' && (
                <label className="mt-3 block text-[11px] font-bold uppercase tracking-wider text-muted">
                  ট্রানজেকশন আইডি
                  <div className="mt-2 flex gap-2">
                    <input
                      inputMode="text"
                      type="text"
                      placeholder="যে নম্বর/ID থেকে টাকা পাঠালেন"
                      value={review.transactionId}
                      onChange={e => setReview(r => r ? { ...r, transactionId: e.target.value } : r)}
                      className="w-full rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2.5 text-sm text-cream outline-none focus:ring-2 focus:ring-gold/20"
                    />
                    {ownerBkashFlow && review.paidVia === 'BKASH' && (
                      <button
                        type="button"
                        onClick={() => void pasteTrxId()}
                        className="shrink-0 rounded-xl border border-gold/40 bg-gold/10 px-4 text-xs font-bold text-gold transition hover:bg-gold/20"
                      >
                        পেস্ট
                      </button>
                    )}
                  </div>
                  <span className="mt-1 block text-[10px] font-normal normal-case text-muted">এই ID সহ staff-কে SMS পাঠানো হবে।</span>
                </label>
              )}
            </div>
            <div className="mobile-modal-footer px-5 pt-3">
              <div className="flex justify-end gap-2">
                <Button size="xs" variant="secondary" type="button" onClick={dismissReview}>বাতিল</Button>
                <Button size="xs" variant={review.action === 'APPROVE' ? 'gold' : 'danger'} type="button" disabled={reviewBusy} onClick={() => void submitReview()}>
                  {reviewBusy ? 'প্রসেসিং…' : review.action === 'APPROVE' ? 'অনুমোদন নিশ্চিত করুন' : 'প্রত্যাখ্যান নিশ্চিত করুন'}
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

function HeroKpiTile({ label, value, tone, isCount, loading }: {
  label: string
  value: number
  tone?: 'pos' | 'neg' | 'amber'
  isCount?: boolean
  loading?: boolean
}) {
  const toneClass = tone === 'pos' ? 'txt-pos' : tone === 'neg' ? 'txt-neg' : tone === 'amber' ? 'text-amber-500' : 'text-cream'
  return (
    <div className="min-w-0 bg-card/60 p-3.5">
      <p className="truncate text-[9px] font-bold uppercase tracking-wider text-muted">{label}</p>
      {loading ? <Skeleton className="mt-2 h-5 w-16" /> : (
        <p className={cn('mt-1 truncate font-mono text-sm font-bold tabular-nums', toneClass)}>
          {isCount ? toBnDigits(value) : `৳ ${value.toLocaleString('en-BD')}`}
        </p>
      )}
    </div>
  )
}
