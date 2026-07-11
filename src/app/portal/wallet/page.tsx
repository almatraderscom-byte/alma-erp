'use client'

/**
 * Full-transparency staff wallet statement (Bangla).
 *
 * Every wallet transaction, grouped by month, with per-fine appeal status and
 * period fine totals (last 30 days / this month / since joining / custom range).
 * Employee-scoped only — reuses the portal's empId resolution.
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { Button, Card, Empty, Skeleton } from '@/components/ui'
import { useBusiness } from '@/contexts/BusinessContext'
import { isSystemOwner, normalizeAlmaRole } from '@/lib/roles'
import { useMyDeskProfile } from '@/hooks/useMyDeskProfile'
import { safeFetchJson } from '@/lib/safe-fetch'
import { dateBn, periodYmBn, toBnDigits } from '@/lib/wallet-labels'
import { PenaltyAppealModal, type PenaltyAppealTarget } from '@/components/attendance/PenaltyAppealModal'
import type { WalletEntryDto, WalletSummary } from '@/types/payroll-wallet'

// Mirrors src/lib/wallet-transparency.ts (not importable client-side / out of scope to edit).
type FineAppealStatus = 'NONE' | 'PENDING' | 'APPROVED' | 'PARTIALLY_APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED'

type FineAppealInfo = {
  status: FineAppealStatus
  appealable: boolean
  deadline: string
  daysLeft: number
  waiverId: string | null
  attendanceRecordId: string | null
  refundEntryId: string | null
  refundedAmount: number
  adminNote: string | null
  reviewedAt: string | null
}

type WalletStatementEntry = WalletEntryDto & {
  labelBn: string
  appeal: FineAppealInfo | null
  createdAt?: string
}

/** Booking date — when the transaction actually happened (salary accruals carry the period's date). */
function bookingDate(e: WalletStatementEntry): string {
  return (e.createdAt ?? e.date) as string
}

type FineWindowSummary = {
  from: string | null
  to: string | null
  fineCount: number
  fineTotal: number
  refundCount: number
  refundTotal: number
  pendingAppeals: number
  netFineCost: number
}

type FineSummaries = {
  appealWindowDays: number
  last30Days: FineWindowSummary
  thisMonth: FineWindowSummary
  sinceJoining: FineWindowSummary
  customRange: FineWindowSummary | null
}

type WalletStatementResponse = {
  employeeId: string
  businessId: string
  summary: WalletSummary
  fineSummaries: FineSummaries
  range: { from: string | null; to: string | null }
  entries: WalletStatementEntry[]
  totalEntryCount: number
}

type PresetMode = 'last30Days' | 'thisMonth' | 'sinceJoining'
type RangeMode = PresetMode | 'custom'

const PRESET_LABEL: Record<PresetMode, string> = {
  last30Days: 'গত ৩০ দিন',
  thisMonth: 'এই মাস',
  sinceJoining: 'শুরু থেকে',
}

// Same set as REFUND_SOURCES in src/lib/wallet-transparency.ts — duplicated locally
// so ADJUSTMENT rows that settle a fine can be indented/connected in the statement.
const REFUND_SOURCES = new Set([
  'attendance_late_penalty_reversal',
  'attendance_exception_refund',
  'attendance_reset_reversal',
])

const PAGE_SIZE = 40

function bnNumber(n: number): string {
  return toBnDigits(Math.round(n).toLocaleString('en-BD'))
}

function moneyBn(n: unknown): string {
  return `৳ ${bnNumber(Number(n || 0))}`
}

function dhakaYearMonth(value: string | Date): { y: number; m: number } {
  const d = typeof value === 'string' ? new Date(value) : value
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: 'numeric',
  }).formatToParts(d)
  return {
    y: Number(parts.find(p => p.type === 'year')?.value || 0),
    m: Number(parts.find(p => p.type === 'month')?.value || 0),
  }
}

function countRejectedInWindow(entries: WalletStatementEntry[], from: Date | null, to: Date | null): number {
  let n = 0
  for (const e of entries) {
    if (e.type !== 'PENALTY' || e.appeal?.status !== 'REJECTED') continue
    const t = new Date(bookingDate(e)).getTime()
    if (from && t < from.getTime()) continue
    if (to && t > to.getTime()) continue
    n += 1
  }
  return n
}

function thisMonthCreditTotal(entries: WalletStatementEntry[]): number {
  const now = dhakaYearMonth(new Date())
  let total = 0
  for (const e of entries) {
    if (e.signedAmount <= 0) continue
    const ym = dhakaYearMonth(bookingDate(e))
    if (ym.y === now.y && ym.m === now.m) total += e.signedAmount
  }
  return total
}

type MonthGroup = { key: string; labelBn: string; rows: WalletStatementEntry[] }

/** Groups an already-newest-first list of entries into Bangla month buckets, preserving order. */
function groupDescByMonth(entriesDesc: WalletStatementEntry[]): MonthGroup[] {
  const map = new Map<string, MonthGroup>()
  for (const e of entriesDesc) {
    const { y, m } = dhakaYearMonth(bookingDate(e))
    const key = `${y}-${String(m).padStart(2, '0')}`
    let group = map.get(key)
    if (!group) {
      group = { key, labelBn: periodYmBn(key) || key, rows: [] }
      map.set(key, group)
    }
    group.rows.push(e)
  }
  return Array.from(map.values())
}

export default function WalletStatementPage() {
  const router = useRouter()
  const { data: session } = useSession()
  const { business } = useBusiness()
  const role = normalizeAlmaRole(session?.user?.role)
  const systemOwner = isSystemOwner(session)
  const isAdmin = role === 'ADMIN' || role === 'SUPER_ADMIN'

  const { loading: loadingMe, employeeId: empId } = useMyDeskProfile(business.id)

  const [fullData, setFullData] = useState<WalletStatementResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [customState, setCustomState] = useState<{ from: string; to: string; data: WalletStatementResponse } | null>(null)
  const [customLoading, setCustomLoading] = useState(false)
  const [rangeMode, setRangeMode] = useState<RangeMode>('last30Days')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [appealTarget, setAppealTarget] = useState<PenaltyAppealTarget | null>(null)

  const loadFull = useCallback(async () => {
    if (!empId) return
    setLoading(true)
    try {
      const result = await safeFetchJson<WalletStatementResponse>(
        `/api/payroll/wallet/${encodeURIComponent(empId)}?business_id=${encodeURIComponent(business.id)}`,
        { cache: 'no-store' },
      )
      if (!result.ok) throw new Error(result.error.message)
      setFullData(result.data)
    } catch (e) {
      toast.error((e as Error).message || 'হিসাব লোড করা যায়নি')
    } finally {
      setLoading(false)
    }
  }, [empId, business.id])

  const loadCustom = useCallback(async (from: string, to: string) => {
    if (!empId) return
    setCustomLoading(true)
    try {
      const result = await safeFetchJson<WalletStatementResponse>(
        `/api/payroll/wallet/${encodeURIComponent(empId)}?business_id=${encodeURIComponent(business.id)}&from=${from}&to=${to}`,
        { cache: 'no-store' },
      )
      if (!result.ok) throw new Error(result.error.message)
      setCustomState({ from, to, data: result.data })
    } catch (e) {
      toast.error((e as Error).message || 'কাস্টম রেঞ্জ লোড করা যায়নি')
    } finally {
      setCustomLoading(false)
    }
  }, [empId, business.id])

  useEffect(() => {
    void loadFull()
  }, [loadFull])

  useEffect(() => {
    if (loadingMe) return
    // Anyone with a linked employee ID may see their own statement — the owner
    // and admins are employees here too. Only unlinked admin/owner accounts
    // bounce to the admin payroll page.
    if ((systemOwner || isAdmin) && !empId) {
      router.replace('/payroll')
    }
  }, [loadingMe, systemOwner, isAdmin, empId, router])

  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [rangeMode, customState?.from, customState?.to])

  const reloadActive = useCallback(() => {
    void loadFull()
    if (rangeMode === 'custom' && customState) void loadCustom(customState.from, customState.to)
  }, [loadFull, loadCustom, rangeMode, customState])

  function selectPreset(mode: PresetMode) {
    setRangeMode(mode)
  }

  function applyCustom() {
    if (!customFrom || !customTo) {
      toast.error('শুরু ও শেষ তারিখ দিন')
      return
    }
    if (customFrom > customTo) {
      toast.error('শুরুর তারিখ শেষের তারিখের আগে হতে হবে')
      return
    }
    setRangeMode('custom')
    void loadCustom(customFrom, customTo)
  }

  const activeEntries = useMemo(
    () => (rangeMode === 'custom' ? (customState?.data.entries ?? []) : (fullData?.entries ?? [])),
    [rangeMode, customState, fullData],
  )
  const activeFineSummary: FineWindowSummary | null = rangeMode === 'custom'
    ? customState?.data.fineSummaries.customRange ?? null
    : fullData?.fineSummaries[rangeMode] ?? null

  const rejectedCount = useMemo(() => {
    if (rangeMode === 'custom') return countRejectedInWindow(customState?.data.entries ?? [], null, null)
    const entries = fullData?.entries ?? []
    const now = new Date()
    if (rangeMode === 'last30Days') return countRejectedInWindow(entries, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), null)
    if (rangeMode === 'thisMonth') return countRejectedInWindow(entries, new Date(now.getFullYear(), now.getMonth(), 1), null)
    return countRejectedInWindow(entries, null, null)
  }, [rangeMode, fullData, customState])

  const monthCredit = useMemo(() => thisMonthCreditTotal(fullData?.entries ?? []), [fullData])
  const thisMonthFineTotal = fullData?.fineSummaries.thisMonth.fineTotal ?? 0
  const pendingAppealsTotal = fullData?.fineSummaries.sinceJoining.pendingAppeals ?? 0

  const sortedDesc = useMemo(() => [...activeEntries].reverse(), [activeEntries])
  const visible = sortedDesc.slice(0, visibleCount)
  const hasMore = sortedDesc.length > visible.length
  const groups = useMemo(() => groupDescByMonth(visible), [visible])

  const heroBalance = fullData
    ? (fullData.entries.length ? fullData.entries[fullData.entries.length - 1].runningBalance : Number(fullData.summary.currentBalance || 0))
    : 0

  function handleAppealSubmitted() {
    setAppealTarget(null)
    reloadActive()
  }

  if (loadingMe || ((systemOwner || isAdmin) && !empId)) {
    return (
      <FinancePageChrome title="সম্পূর্ণ হিসাব" subtitle="আপনার ওয়ালেটের সব লেনদেন ও জরিমানার আপিল অবস্থা" hideDateFilter>
        <Skeleton className="h-52 w-full rounded-2xl" />
      </FinancePageChrome>
    )
  }

  if (!empId) {
    return (
      <FinancePageChrome title="সম্পূর্ণ হিসাব" subtitle="আপনার ওয়ালেটের সব লেনদেন ও জরিমানার আপিল অবস্থা" hideDateFilter>
        <Card className="p-5">
          <Empty
            title="ওয়ালেট চালু নেই"
            desc="আপনার HR এমপ্লয়ি আইডি এখনও লিংক করা হয়নি — অ্যাডমিনকে জানান।"
            action={<Link href="/portal"><Button size="sm" variant="secondary">My desk-এ ফিরুন</Button></Link>}
          />
        </Card>
      </FinancePageChrome>
    )
  }

  return (
    <FinancePageChrome title="সম্পূর্ণ হিসাব" subtitle="আপনার ওয়ালেটের সব লেনদেন ও জরিমানার আপিল অবস্থা" hideDateFilter>
      <div className="space-y-4">
        {/* Hero */}
        <Card className="p-5 border-gold-dim/25 bg-gradient-to-br from-gold/10 via-card to-white/80">
          {loading && !fullData ? <Skeleton className="h-24 w-full" /> : (
            <>
              <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">বর্তমান ব্যালেন্স</p>
              <p className="mt-2 font-mono text-3xl font-black tabular-nums text-cream">{moneyBn(heroBalance)}</p>
              <p className="mt-1 text-[11px] text-muted">
                মোট {bnNumber(fullData?.totalEntryCount ?? 0)}টি লেনদেন
              </p>
            </>
          )}
        </Card>

        {/* Mini stat row */}
        {fullData && (
          <div className="grid grid-cols-3 gap-2">
            <MiniStat label="এ মাসে জমা" value={moneyBn(monthCredit)} tone="text-green-400" />
            <MiniStat label="জরিমানা (এ মাস)" value={moneyBn(thisMonthFineTotal)} tone="text-red-400" />
            <MiniStat label="অপেক্ষায় আপিল" value={`${bnNumber(pendingAppealsTotal)}টি`} tone="text-amber-400" />
          </div>
        )}

        {/* Fine summary card */}
        <Card className="p-5 border-gold-dim/20 bg-card/78 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">জরিমানা — {rangeMode === 'custom' ? 'কাস্টম রেঞ্জ' : PRESET_LABEL[rangeMode]}</p>
          </div>

          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {(['last30Days', 'thisMonth', 'sinceJoining'] as PresetMode[]).map(mode => (
              <button
                key={mode}
                type="button"
                onClick={() => selectPreset(mode)}
                className={`rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${
                  rangeMode === mode ? 'border-gold-dim/50 bg-gold/15 text-gold-lt' : 'border-white/[0.08] bg-card/85 text-muted hover:text-cream'
                }`}
              >
                {PRESET_LABEL[mode]}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setRangeMode('custom')}
              className={`rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${
                rangeMode === 'custom' ? 'border-gold-dim/50 bg-gold/15 text-gold-lt' : 'border-white/[0.08] bg-card/85 text-muted hover:text-cream'
              }`}
            >
              কাস্টম রেঞ্জ
            </button>
          </div>

          {rangeMode === 'custom' && (
            <div className="flex flex-wrap items-end gap-2 text-[11px]">
              <label className="block space-y-1">
                <span className="text-muted">শুরুর তারিখ</span>
                <input
                  type="date"
                  value={customFrom}
                  onChange={e => setCustomFrom(e.target.value)}
                  className="rounded-lg border border-gold-dim/40 bg-white/80 p-2 text-xs text-cream"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-muted">শেষ তারিখ</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={e => setCustomTo(e.target.value)}
                  className="rounded-lg border border-gold-dim/40 bg-white/80 p-2 text-xs text-cream"
                />
              </label>
              <Button size="sm" variant="gold" disabled={customLoading} onClick={applyCustom}>
                {customLoading ? 'লোড হচ্ছে…' : 'প্রয়োগ করুন'}
              </Button>
            </div>
          )}

          {(loading && !fullData) || (rangeMode === 'custom' && customLoading && !customState) ? (
            <Skeleton className="h-24 w-full" />
          ) : !activeFineSummary ? (
            <p className="text-[11px] text-muted">তারিখ বেছে নিয়ে &ldquo;প্রয়োগ করুন&rdquo; চাপুন।</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <FineStat label="মোট জরিমানা" primary={`${bnNumber(activeFineSummary.fineCount)}টি`} secondary={moneyBn(activeFineSummary.fineTotal)} tone="text-red-400" />
              <FineStat label="আপিলে ফেরত" primary={`${bnNumber(activeFineSummary.refundCount)}টি`} secondary={moneyBn(activeFineSummary.refundTotal)} tone="text-green-400" />
              <FineStat label="নাকচ" primary={`${bnNumber(rejectedCount)}টি`} tone="text-muted-hi" />
              <FineStat label="আপিল বাকি" primary={`${bnNumber(activeFineSummary.pendingAppeals)}টি`} tone="text-amber-400" />
            </div>
          )}

          <p className="text-[10px] text-muted">
            আপিলের সময়সীমা: জরিমানার দিন থেকে {toBnDigits(fullData?.fineSummaries.appealWindowDays ?? 30)} দিন
          </p>
        </Card>

        {/* Statement */}
        <Card className="p-5 space-y-1">
          <p className="text-sm font-bold text-cream mb-2">লেনদেনের বিস্তারিত বিবরণী</p>
          {loading && !fullData ? (
            <Skeleton className="h-40 w-full" />
          ) : !groups.length ? (
            <Empty title="কোনো লেনদেন নেই" desc="এই সময়ের মধ্যে ওয়ালেটে কোনো লেনদেন হয়নি।" />
          ) : (
            <div className="divide-y divide-border">
              {groups.map(group => (
                <div key={group.key} className="py-2">
                  <p className="sticky top-0 z-[1] bg-card/95 py-1.5 text-[10px] font-black uppercase tracking-[0.12em] text-gold">
                    {group.labelBn}
                  </p>
                  <div className="divide-y divide-white/[0.04]">
                    {group.rows.map((row, idx) => (
                      <StatementRow
                        key={String(row.id ?? `${group.key}-${idx}`)}
                        entry={row}
                        onOpenAppeal={setAppealTarget}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {hasMore && (
            <div className="pt-3 flex justify-center">
              <Button size="sm" variant="secondary" onClick={() => setVisibleCount(c => c + PAGE_SIZE)}>
                আরো দেখুন
              </Button>
            </div>
          )}
        </Card>
      </div>

      {appealTarget && (
        <PenaltyAppealModal
          open={Boolean(appealTarget)}
          businessId={business.id}
          target={appealTarget}
          onClose={() => setAppealTarget(null)}
          onSubmitted={handleAppealSubmitted}
        />
      )}
    </FinancePageChrome>
  )
}

function MiniStat({ label, value, tone = 'text-cream' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.04] p-3">
      <p className="text-[9px] font-bold uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-1 font-mono text-sm font-bold tabular-nums ${tone}`}>{value}</p>
    </div>
  )
}

function FineStat({ label, primary, secondary, tone = 'text-cream' }: { label: string; primary: string; secondary?: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.04] p-3">
      <p className="text-[9px] font-bold uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-1 font-mono text-sm font-bold tabular-nums ${tone}`}>{primary}</p>
      {secondary && <p className="mt-0.5 font-mono text-[10px] tabular-nums text-muted">{secondary}</p>}
    </div>
  )
}

function DirectionIcon({ signedAmount, isRefund }: { signedAmount: number; isRefund: boolean }) {
  const positive = signedAmount >= 0
  const tone = isRefund
    ? 'border-gold-dim/40 bg-gold/10 text-gold-lt'
    : positive
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
      : 'border-red-500/30 bg-red-500/10 text-red-400'
  return (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${tone}`}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        {isRefund ? (
          <path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />
        ) : positive ? (
          <path d="M7 17 17 7M9 7h8v8" />
        ) : (
          <path d="M17 7 7 17M7 9v8h8" />
        )}
      </svg>
    </span>
  )
}

const APPEAL_CHIP_BASE = 'mt-1.5 inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-bold'

function AppealChip({ entry, onOpenAppeal }: { entry: WalletStatementEntry; onOpenAppeal: (t: PenaltyAppealTarget) => void }) {
  const a = entry.appeal
  if (!a) return null

  function openModal() {
    if (!a || !a.attendanceRecordId) return
    onOpenAppeal({
      attendanceRecordId: a.attendanceRecordId,
      penaltyAmount: Math.round(Math.abs(entry.signedAmount)),
      lateMinutes: 0,
      attendanceDate: String(entry.date).slice(0, 10),
    })
  }

  switch (a.status) {
    case 'NONE':
    case 'CANCELLED':
      if (!a.appealable) return null
      if (a.attendanceRecordId) {
        return (
          <button type="button" onClick={openModal} className={`${APPEAL_CHIP_BASE} border-gold-dim/40 bg-gold/10 text-gold-lt`}>
            আপিল করুন — আর {toBnDigits(a.daysLeft)} দিন
          </button>
        )
      }
      return (
        <Link href="/portal#attendance" className={`${APPEAL_CHIP_BASE} border-gold-dim/40 bg-gold/10 text-gold-lt`}>
          আপিল করুন — আর {toBnDigits(a.daysLeft)} দিন
        </Link>
      )
    case 'PENDING':
      return <span className={`${APPEAL_CHIP_BASE} border-amber-500/30 bg-amber-500/10 text-amber-300`}>আপিল অপেক্ষায়</span>
    case 'APPROVED':
    case 'PARTIALLY_APPROVED':
      return (
        <span className={`${APPEAL_CHIP_BASE} border-emerald-500/30 bg-emerald-500/10 text-emerald-300`}>
          আপিল মঞ্জুর — {moneyBn(a.refundedAmount)} ফেরত
        </span>
      )
    case 'REJECTED':
      return (
        <div>
          <span className={`${APPEAL_CHIP_BASE} border-red-500/30 bg-red-500/10 text-red-300`}>আপিল নাকচ</span>
          {a.adminNote && <p className="mt-1 text-[10px] text-muted">কারণ: {a.adminNote}</p>}
        </div>
      )
    case 'EXPIRED':
      return <span className={`${APPEAL_CHIP_BASE} border-border bg-white/[0.03] text-muted`}>আপিলের সময় শেষ</span>
    default:
      return null
  }
}

function StatementRow({ entry, onOpenAppeal }: { entry: WalletStatementEntry; onOpenAppeal: (t: PenaltyAppealTarget) => void }) {
  const isRefund = entry.type === 'ADJUSTMENT' && Boolean(entry.source) && REFUND_SOURCES.has(String(entry.source))
  const dateLabel = dateBn(bookingDate(entry))
  const noteText = entry.note ? String(entry.note).trim() : ''
  const secondLine = noteText ? `${noteText} · ${dateLabel}` : dateLabel

  const row = (
    <div className="py-3 flex items-start gap-3">
      <DirectionIcon signedAmount={entry.signedAmount} isRefund={isRefund} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-cream">{entry.labelBn}</p>
        <p className="mt-0.5 text-[11px] text-muted truncate">{secondLine}</p>
        {entry.type === 'PENALTY' && <AppealChip entry={entry} onOpenAppeal={onOpenAppeal} />}
      </div>
      <div className="text-right shrink-0">
        <p className={`font-mono text-sm font-bold tabular-nums ${entry.signedAmount >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {entry.signedAmount >= 0 ? '+' : '-'}{moneyBn(Math.abs(entry.signedAmount))}
        </p>
        <p className="mt-0.5 font-mono text-[10px] tabular-nums text-gold-lt">{moneyBn(entry.runningBalance)}</p>
      </div>
    </div>
  )

  if (!isRefund) return row
  return (
    <div className="ml-4 border-l-2 border-gold-dim/25 pl-3">
      {row}
    </div>
  )
}
