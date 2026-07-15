'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  expenseDate: string | null
  hasReceipt: boolean
  status: string
  createdAt: string
  resolvedAt: string | null
}

type ListResponse = {
  ok?: boolean
  claims?: ClaimRow[]
  pendingTotal?: number
}

/** One not-yet-submitted expense in the batch basket. */
type DraftExpense = {
  key: string
  amount: number
  category: string
  vendor: string
  note: string
  expenseDate: string
  receiptFile: File | null
}

const CATEGORY_OPTIONS = [
  'বসের ব্যক্তিগত কাজ',
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

function fmtDay(ymd: string): string {
  try {
    return new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short' }).format(
      new Date(`${ymd}T00:00:00+06:00`),
    )
  } catch {
    return ymd
  }
}

function todayYmd(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date())
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
  const [expenseDate, setExpenseDate] = useState(todayYmd())
  const [receiptFile, setReceiptFile] = useState<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [drafts, setDrafts] = useState<DraftExpense[]>([])

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
  const draftsTotal = useMemo(() => drafts.reduce((s, d) => s + d.amount, 0), [drafts])

  /** Add the form's current values to the batch basket (nothing sent yet). */
  const addToBasket = useCallback(() => {
    const num = Number(String(amount).replace(/[^0-9.]/g, ''))
    if (!(num > 0)) {
      toast.error('সঠিক একটি টাকার অঙ্ক দিন।')
      return
    }
    if (drafts.length >= 20) {
      toast.error('একসাথে সর্বোচ্চ ২০টি খরচ জমা দেওয়া যায়।')
      return
    }
    setDrafts((prev) => [
      ...prev,
      {
        key: `${Date.now()}-${prev.length}`,
        amount: num,
        category,
        vendor: vendor.trim(),
        note: note.trim(),
        expenseDate,
        receiptFile,
      },
    ])
    setAmount('')
    setVendor('')
    setNote('')
    setReceiptFile(null)
    setExpenseDate(todayYmd())
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [amount, category, vendor, note, expenseDate, receiptFile, drafts.length])

  const removeDraft = useCallback((key: string) => {
    setDrafts((prev) => prev.filter((d) => d.key !== key))
  }, [])

  /** Upload one receipt file → attachment id (null on no file). */
  const uploadReceipt = useCallback(
    async (file: File | null): Promise<string | null> => {
      if (!file) return null
      const form = new FormData()
      form.append('file', file)
      form.append('business_id', businessId)
      const res = await fetch('/api/finance/receipts', { method: 'POST', body: form })
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; attachment?: { id?: string }; error?: string }
      if (!res.ok || !data.attachment?.id) {
        throw new Error(data.error || 'রসিদ আপলোড করা যায়নি।')
      }
      return data.attachment.id
    },
    [businessId],
  )

  /** Send every basket item in ONE request — each becomes its own approval. */
  const submitAll = useCallback(async () => {
    if (!drafts.length) return
    setSubmitting(true)
    try {
      const items = []
      for (const d of drafts) {
        const receiptAttachmentId = await uploadReceipt(d.receiptFile)
        items.push({
          amount: d.amount,
          category: d.category,
          vendor: d.vendor || undefined,
          note: d.note || undefined,
          expense_date: d.expenseDate,
          receipt_attachment_id: receiptAttachmentId || undefined,
        })
      }
      const result = await safeFetchJson<{ ok?: boolean; message?: string }>('/api/finance/reimbursement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: businessId, items }),
      })
      if (result.ok) {
        toast.success(result.data.message || 'আবেদন পাঠানো হয়েছে।')
        setDrafts([])
        void load()
      } else {
        toast.error(result.error.message || 'আবেদন পাঠানো যায়নি।')
      }
    } catch (e) {
      toast.error((e as Error).message || 'আবেদন পাঠানো যায়নি।')
    } finally {
      setSubmitting(false)
    }
  }, [drafts, businessId, uploadReceipt, load])

  return (
    <FinancePageChrome
      title="Personal Expense"
      subtitle="বস বা অফিসের কাজে নিজের টাকায় খরচ করেছেন? একসাথে যতগুলো দরকার যোগ করে জমা দিন"
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
          <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted">অনুমোদিত</p>
          <Money amount={approvedTotal} className="mt-1 block text-xl font-bold text-emerald-400" />
          <p className="mt-0.5 text-[11px] text-muted">
            <Link href="/portal" className="text-gold-lt font-bold">
              আমার ওয়ালেট দেখুন →
            </Link>
          </p>
        </Card>
      </div>

      {/* New claim form → basket */}
      <Card className="p-4 md:p-5">
        <h2 className="mb-3 text-sm font-bold text-cream">খরচ যোগ করুন</h2>
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
            <label className="mb-1 block text-[11px] font-bold text-muted">খরচের তারিখ *</label>
            <Input type="date" value={expenseDate} max={todayYmd()} onChange={(e) => setExpenseDate(e.target.value)} />
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
            <Input placeholder="সংক্ষিপ্ত বিবরণ" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-muted">রসিদ / প্রমাণ (ঐচ্ছিক)</label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
              onChange={(e) => setReceiptFile(e.target.files?.[0] ?? null)}
              className="w-full rounded-xl border border-border-strong bg-card px-4 py-2.5 text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-gold/15 file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-gold-lt"
            />
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted">যোগ করলে নিচের তালিকায় জমবে — এখনই পাঠানো হবে না।</p>
          <Button variant="ghost" size="md" onClick={addToBasket} disabled={submitting}>
            ＋ তালিকায় যোগ করুন
          </Button>
        </div>
      </Card>

      {/* Basket */}
      {drafts.length > 0 && (
        <Card className="border-gold-dim/40 p-4 md:p-5">
          <h2 className="mb-3 text-sm font-bold text-cream">জমা দেওয়ার তালিকা ({drafts.length}টি)</h2>
          <div className="divide-y divide-border-subtle">
            {drafts.map((d) => (
              <div key={d.key} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-cream">
                    <Money amount={d.amount} /> · {d.category}
                  </p>
                  <p className="truncate text-[11px] text-muted">
                    {fmtDay(d.expenseDate)}
                    {d.vendor ? ` · ${d.vendor}` : ''}
                    {d.note ? ` · ${d.note}` : ''}
                    {d.receiptFile ? ' · 📎 রসিদ' : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => removeDraft(d.key)}
                  disabled={submitting}
                  aria-label="বাদ দিন"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-2 text-xs text-muted hover:text-danger"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <Button variant="gold" size="md" className="mt-3 w-full justify-center" onClick={submitAll} loading={submitting}>
            একসাথে জমা দিন ({drafts.length}টি · <Money amount={draftsTotal} />)
          </Button>
          <p className="mt-2 text-center text-[11px] text-muted">সব খরচ একসাথে মালিকের Approval Center-এ যাবে।</p>
        </Card>
      )}

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
                  <p className="truncate text-sm font-semibold text-cream">
                    {c.category}
                    {c.hasReceipt && <span className="ml-1.5 text-[10px] text-gold-lt">📎</span>}
                  </p>
                  {c.note && <p className="truncate text-[11px] text-muted">{c.note}</p>}
                  <p className="mt-0.5 text-[10px] text-muted">
                    {c.expenseDate ? `খরচ: ${fmtDay(c.expenseDate)} · ` : ''}
                    {fmtDate(c.createdAt)}
                  </p>
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
