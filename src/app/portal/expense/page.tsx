'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import toast from 'react-hot-toast'
import { Button, Card, Input, Empty, Skeleton, Money, GoldDivider } from '@/components/ui'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { useBusiness } from '@/contexts/BusinessContext'
import { safeFetchJson } from '@/lib/safe-fetch'

type ClaimRow = {
  id: string
  amount: number
  category: string
  note: string | null
  status: string
  createdAt: string
  resolvedAt: string | null
}

type ListResponse = {
  ok?: boolean
  claims?: ClaimRow[]
  pendingTotal?: number
}

const CATEGORY_OPTIONS = [
  'যাতায়াত / কুরিয়ার',
  'অফিস সামগ্রী',
  'খাবার / আপ্যায়ন',
  'মেরামত',
  'অন্যান্য',
]

/** Bangla status pill for a claim. */
function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    PENDING: { label: 'অপেক্ষমাণ', cls: 'text-amber-400 bg-amber-400/10 border-amber-400/25' },
    APPROVED: { label: 'অনুমোদিত', cls: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/25' },
    REJECTED: { label: 'প্রত্যাখ্যাত', cls: 'text-danger bg-danger/10 border-danger/25' },
  }
  const c = map[status] ?? { label: status, cls: 'text-muted bg-bg-2 border-border-subtle' }
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold border ${c.cls}`}>
      {c.label}
    </span>
  )
}

function fmtDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('bn-BD', {
      timeZone: 'Asia/Dhaka',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

export default function StaffExpensePage() {
  const { business } = useBusiness()
  const businessId = business.id

  const [claims, setClaims] = useState<ClaimRow[]>([])
  const [pendingTotal, setPendingTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState(CATEGORY_OPTIONS[0])
  const [vendor, setVendor] = useState('')
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const result = await safeFetchJson<ListResponse>(
      `/api/finance/reimbursement?business_id=${encodeURIComponent(businessId)}`,
      { cache: 'no-store' },
    )
    if (result.ok) {
      setClaims(result.data.claims || [])
      setPendingTotal(result.data.pendingTotal || 0)
    } else {
      toast.error(result.error.message || 'আপনার আবেদনগুলো লোড করা যায়নি।')
    }
    setLoading(false)
  }, [businessId])

  useEffect(() => {
    void load()
  }, [load])

  const approvedTotal = useMemo(
    () => claims.filter((c) => c.status === 'APPROVED').reduce((s, c) => s + c.amount, 0),
    [claims],
  )

  const submit = useCallback(async () => {
    const num = Number(String(amount).replace(/[^0-9.]/g, ''))
    if (!(num > 0)) {
      toast.error('সঠিক একটি টাকার অঙ্ক দিন।')
      return
    }
    setSubmitting(true)
    const result = await safeFetchJson<{ ok?: boolean; message?: string }>(
      '/api/finance/reimbursement',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: businessId,
          amount: num,
          category,
          vendor: vendor.trim() || undefined,
          note: note.trim() || undefined,
        }),
      },
    )
    setSubmitting(false)
    if (result.ok) {
      toast.success(result.data.message || 'ফেরতের আবেদন পাঠানো হয়েছে।')
      setAmount('')
      setVendor('')
      setNote('')
      void load()
    } else {
      toast.error(result.error.message || 'আবেদন পাঠানো যায়নি।')
    }
  }, [amount, businessId, category, vendor, note, load])

  return (
    <FinancePageChrome
      title="নিজ খরচ ফেরত"
      subtitle="নিজের পকেট থেকে অফিসের খরচ করেছেন? এখানে ফেরতের আবেদন করুন"
      hideDateFilter
    >
      {/* Summary */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Card className="p-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted">অপেক্ষমাণ</p>
          <Money amount={pendingTotal} className="mt-1 block text-xl font-bold text-amber-400" />
          <p className="mt-0.5 text-[11px] text-muted">মালিকের অনুমোদনের অপেক্ষায়</p>
        </Card>
        <Card className="p-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted">অনুমোদিত (ওয়ালেটে যুক্ত)</p>
          <Money amount={approvedTotal} className="mt-1 block text-xl font-bold text-emerald-400" />
          <p className="mt-0.5 text-[11px] text-muted">
            <Link href="/portal" className="text-gold-lt font-bold">
              আমার ওয়ালেট দেখুন →
            </Link>
          </p>
        </Card>
      </div>

      {/* New claim form */}
      <Card className="p-4 md:p-5">
        <h2 className="mb-3 text-sm font-bold text-cream">নতুন আবেদন</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-[11px] font-bold text-muted">টাকার অঙ্ক *</label>
            <Input
              inputMode="numeric"
              placeholder="যেমন: 500"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-muted">খরচের ধরন</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-xl border border-border-strong bg-card px-4 py-3 text-sm text-cream focus:border-gold/60 focus:outline-none"
            >
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-muted">কোথায় খরচ (ঐচ্ছিক)</label>
            <Input
              placeholder="দোকান / প্রতিষ্ঠানের নাম"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-muted">নোট (ঐচ্ছিক)</label>
            <Input
              placeholder="সংক্ষিপ্ত বিবরণ"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted">
            মালিক অনুমোদন করলে টাকা আপনার ওয়ালেটে যোগ হবে।
          </p>
          <Button variant="gold" size="md" onClick={submit} loading={submitting}>
            আবেদন পাঠান
          </Button>
        </div>
      </Card>

      {/* History */}
      <Card className="p-4 md:p-5">
        <h2 className="mb-3 text-sm font-bold text-cream">আমার আবেদনসমূহ</h2>
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : claims.length === 0 ? (
          <Empty title="কোনো আবেদন নেই" desc="আপনি এখনো কোনো ফেরতের আবেদন করেননি।" />
        ) : (
          <div className="divide-y divide-border-subtle">
            {claims.map((c) => (
              <div key={c.id} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-cream">{c.category}</p>
                  {c.note && <p className="truncate text-[11px] text-muted">{c.note}</p>}
                  <p className="mt-0.5 text-[10px] text-muted">{fmtDate(c.createdAt)}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Money amount={c.amount} className="text-sm font-bold text-cream" />
                  <StatusPill status={c.status} />
                </div>
              </div>
            ))}
          </div>
        )}
        <GoldDivider className="my-3" />
        <p className="text-[10px] text-muted">
          শুধু যোগ করা যায় — পাঠানো আবেদন সম্পাদনা বা মুছে ফেলা যায় না (নিরাপত্তার জন্য)।
        </p>
      </Card>
    </FinancePageChrome>
  )
}
