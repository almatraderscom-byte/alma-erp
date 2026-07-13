'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Button, Card, Input, Empty, Skeleton, Money } from '@/components/ui'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { safeFetchJson } from '@/lib/safe-fetch'

/**
 * Owner personal পাওনা-দেনা khata — persons/organisations OUTSIDE the staff
 * system. One khata per party; serial transactions with a running balance;
 * every entry owner-adjustable (edit/delete, history kept server-side).
 * SUPER_ADMIN only (API-enforced).
 */

type PartyRow = {
  id: string
  name: string
  phone: string | null
  net: number
  txnCount: number
  lastTxnDate: string | null
}

type Txn = {
  id: string
  direction: 'OUT' | 'IN'
  amount: number
  reason: string
  txnDate: string
  createdAt: string
  edited: boolean
}

type PartyDetail = {
  id: string
  name: string
  phone: string | null
  note: string | null
  net: number
  txns: Txn[]
}

type ListResponse = {
  ok?: boolean
  parties?: PartyRow[]
  totalReceivable?: number
  totalPayable?: number
  net?: number
}

type DetailResponse = { ok?: boolean; party?: PartyDetail }

type Filter = 'all' | 'recv' | 'pay' | 'settled'

function todayYmd(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date())
}

function fmtDay(ymd: string | null): string {
  if (!ymd) return '—'
  try {
    return new Intl.DateTimeFormat('bn-BD', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(
      new Date(`${ymd}T00:00:00.000Z`),
    )
  } catch {
    return ymd
  }
}

/** পাওনা / দেনা / নিষ্পত্তি pill. */
function NetPill({ net }: { net: number }) {
  const cls =
    net > 0
      ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/25'
      : net < 0
        ? 'text-danger bg-danger/10 border-danger/25'
        : 'text-muted bg-bg-2 border-border-subtle'
  const label = net > 0 ? 'আমি পাব' : net < 0 ? 'আমি দেব' : 'নিষ্পত্তি'
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold border ${cls}`}>
      {label}
    </span>
  )
}

/** Direction segmented control (টাকা দিলাম / টাকা নিলাম). */
function DirectionSeg({
  value,
  onChange,
  disabled,
}: {
  value: 'OUT' | 'IN'
  onChange: (v: 'OUT' | 'IN') => void
  disabled?: boolean
}) {
  return (
    <div className="flex rounded-xl border border-border-strong bg-bg-2 p-0.5">
      {(
        [
          ['OUT', 'টাকা দিলাম'],
          ['IN', 'টাকা নিলাম'],
        ] as const
      ).map(([v, label]) => (
        <button
          key={v}
          type="button"
          disabled={disabled}
          onClick={() => onChange(v)}
          className={`flex-1 rounded-[10px] px-3 py-2 text-xs font-bold transition ${
            value === v
              ? v === 'OUT'
                ? 'bg-card text-danger shadow'
                : 'bg-card text-emerald-400 shadow'
              : 'text-muted'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export default function PersonalLedgerPage() {
  const [parties, setParties] = useState<PartyRow[]>([])
  const [totals, setTotals] = useState({ recv: 0, pay: 0, net: 0 })
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')

  const [detail, setDetail] = useState<PartyDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  // New party form
  const [pName, setPName] = useState('')
  const [pAmount, setPAmount] = useState('')
  const [pDirection, setPDirection] = useState<'OUT' | 'IN'>('OUT')
  const [pReason, setPReason] = useState('')
  const [pDate, setPDate] = useState(todayYmd())

  // Add-txn form (inside detail)
  const [tAmount, setTAmount] = useState('')
  const [tDirection, setTDirection] = useState<'OUT' | 'IN'>('OUT')
  const [tReason, setTReason] = useState('')
  const [tDate, setTDate] = useState(todayYmd())

  // Inline edit state
  const [editId, setEditId] = useState<string | null>(null)
  const [eAmount, setEAmount] = useState('')
  const [eDirection, setEDirection] = useState<'OUT' | 'IN'>('OUT')
  const [eReason, setEReason] = useState('')
  const [eDate, setEDate] = useState(todayYmd())

  const load = useCallback(async () => {
    setLoading(true)
    const result = await safeFetchJson<ListResponse>('/api/finance/personal-ledger', { cache: 'no-store' })
    if (result.ok) {
      setParties(result.data.parties || [])
      setTotals({
        recv: result.data.totalReceivable || 0,
        pay: result.data.totalPayable || 0,
        net: result.data.net || 0,
      })
      setForbidden(false)
    } else if (result.status === 403) {
      setForbidden(true)
    } else {
      toast.error(result.error.message || 'খাতা লোড করা যায়নি।')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openParty = useCallback(async (id: string) => {
    setDetailLoading(true)
    setEditId(null)
    const result = await safeFetchJson<DetailResponse>(`/api/finance/personal-ledger?party_id=${encodeURIComponent(id)}`, {
      cache: 'no-store',
    })
    if (result.ok && result.data.party) {
      setDetail(result.data.party)
      window.scrollTo({ top: 0 })
    } else {
      toast.error('খাতাটি লোড করা যায়নি।')
    }
    setDetailLoading(false)
  }, [])

  const closeParty = useCallback(() => {
    setDetail(null)
    setEditId(null)
    void load()
  }, [load])

  const post = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true)
    const result = await safeFetchJson<{ ok?: boolean; message?: string; partyId?: string }>(
      '/api/finance/personal-ledger',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    )
    setBusy(false)
    if (result.ok) {
      toast.success(result.data.message || 'সংরক্ষণ হয়েছে।')
      return true
    }
    toast.error(result.error.message || 'সংরক্ষণ করা যায়নি।')
    return false
  }, [])

  const createParty = useCallback(async () => {
    const amount = Number(String(pAmount).replace(/[^0-9.]/g, ''))
    if (!pName.trim() || !(amount > 0) || !pReason.trim()) {
      toast.error('নাম, পরিমাণ ও কারণ দিন।')
      return
    }
    const ok = await post({
      op: 'create_party',
      name: pName.trim(),
      amount,
      direction: pDirection,
      reason: pReason.trim(),
      txn_date: pDate,
    })
    if (ok) {
      setPName('')
      setPAmount('')
      setPReason('')
      setPDirection('OUT')
      setPDate(todayYmd())
      void load()
    }
  }, [pName, pAmount, pDirection, pReason, pDate, post, load])

  const addTxn = useCallback(async () => {
    if (!detail) return
    const amount = Number(String(tAmount).replace(/[^0-9.]/g, ''))
    if (!(amount > 0) || !tReason.trim()) {
      toast.error('পরিমাণ ও কারণ দিন।')
      return
    }
    const ok = await post({
      op: 'add_txn',
      party_id: detail.id,
      amount,
      direction: tDirection,
      reason: tReason.trim(),
      txn_date: tDate,
    })
    if (ok) {
      setTAmount('')
      setTReason('')
      setTDirection('OUT')
      setTDate(todayYmd())
      void openParty(detail.id)
    }
  }, [detail, tAmount, tDirection, tReason, tDate, post, openParty])

  const startEdit = useCallback((t: Txn) => {
    setEditId(t.id)
    setEAmount(String(t.amount))
    setEDirection(t.direction)
    setEReason(t.reason)
    setEDate(t.txnDate)
  }, [])

  const saveEdit = useCallback(async () => {
    if (!detail || !editId) return
    const amount = Number(String(eAmount).replace(/[^0-9.]/g, ''))
    if (!(amount > 0) || !eReason.trim()) {
      toast.error('সঠিক পরিমাণ ও কারণ দিন।')
      return
    }
    const ok = await post({
      op: 'edit_txn',
      txn_id: editId,
      amount,
      direction: eDirection,
      reason: eReason.trim(),
      txn_date: eDate,
    })
    if (ok) {
      setEditId(null)
      void openParty(detail.id)
    }
  }, [detail, editId, eAmount, eDirection, eReason, eDate, post, openParty])

  const deleteTxn = useCallback(
    async (txnId: string) => {
      if (!detail) return
      const ok = await post({ op: 'delete_txn', txn_id: txnId })
      if (ok) {
        setEditId(null)
        void openParty(detail.id)
      }
    },
    [detail, post, openParty],
  )

  const filteredParties = useMemo(() => {
    if (filter === 'recv') return parties.filter((p) => p.net > 0)
    if (filter === 'pay') return parties.filter((p) => p.net < 0)
    if (filter === 'settled') return parties.filter((p) => p.net === 0)
    return parties
  }, [parties, filter])

  /** Serial rows with a running balance after each txn. */
  const detailRows = useMemo(() => {
    if (!detail) return []
    let run = 0
    return detail.txns.map((t) => {
      run += t.direction === 'OUT' ? t.amount : -t.amount
      return { t, run }
    })
  }, [detail])

  if (forbidden) {
    return (
      <FinancePageChrome title="পাওনা-দেনা" subtitle="ব্যক্তিগত খাতা" hideDateFilter>
        <Card className="p-6">
          <Empty title="শুধু মালিকের জন্য" desc="এই খাতা শুধু Super Admin দেখতে পারেন।" />
        </Card>
      </FinancePageChrome>
    )
  }

  /* ─────────── party detail (খতিয়ান) ─────────── */
  if (detail) {
    return (
      <FinancePageChrome title={detail.name} subtitle="লেনদেনের খতিয়ান · পুরোনো থেকে নতুন" hideDateFilter>
        <button type="button" onClick={closeParty} className="text-left text-sm font-bold text-gold-lt">
          ‹ পাওনা-দেনা তালিকায় ফিরুন
        </button>

        <Card className="p-5 text-center">
          <p
            className={`text-2xl font-black ${detail.net > 0 ? 'text-emerald-400' : detail.net < 0 ? 'text-danger' : 'text-muted'}`}
          >
            {detail.net < 0 ? '−' : ''}
            <Money amount={Math.abs(detail.net)} />
          </p>
          <p className="mt-1 text-[11px] text-muted">
            {detail.net > 0 ? 'সে আমাকে দেবে (আমি পাব)' : detail.net < 0 ? 'আমি তাকে দেব (আমার দেনা)' : 'হিসাব নিষ্পত্তি ✓'}
          </p>
        </Card>

        <Card className="p-4 md:p-5">
          <h2 className="mb-3 text-sm font-bold text-cream">
            লেনদেনের খতিয়ান <span className="text-[11px] font-normal text-muted">({detail.txns.length}টি · ✎ চেপে +/− অ্যাডজাস্ট)</span>
          </h2>
          {detailRows.length === 0 ? (
            <Empty title="কোনো লেনদেন নেই" />
          ) : (
            <div className="divide-y divide-border-subtle">
              {detailRows.map(({ t, run }) => (
                <div key={t.id} className="py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-cream">
                        {t.direction === 'OUT' ? '↑ টাকা দিলাম' : '↓ টাকা নিলাম'} · {t.reason}
                        {t.edited && <span className="ml-1.5 text-[10px] text-muted">(অ্যাডজাস্ট করা)</span>}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted">{fmtDay(t.txnDate)}</p>
                      <p className="mt-0.5 text-[10px] text-muted">
                        ব্যালেন্স: {run < 0 ? '−' : ''}
                        <Money amount={Math.abs(run)} /> {run > 0 ? 'আমি পাব' : run < 0 ? 'আমি দেব' : '— নিষ্পত্তি'}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className={`text-sm font-bold ${t.direction === 'OUT' ? 'text-danger' : 'text-emerald-400'}`}>
                        {t.direction === 'OUT' ? '−' : '+'}
                        <Money amount={t.amount} />
                      </span>
                      <button
                        type="button"
                        onClick={() => (editId === t.id ? setEditId(null) : startEdit(t))}
                        className="flex h-7 w-7 items-center justify-center rounded-full bg-bg-2 text-xs text-muted hover:text-gold-lt"
                        aria-label="অ্যাডজাস্ট"
                      >
                        {editId === t.id ? '▾' : '✎'}
                      </button>
                    </div>
                  </div>

                  {editId === t.id && (
                    <div className="mt-3 space-y-2 rounded-2xl border border-border bg-bg-2/60 p-3">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <DirectionSeg value={eDirection} onChange={setEDirection} disabled={busy} />
                        <Input inputMode="numeric" value={eAmount} onChange={(e) => setEAmount(e.target.value)} placeholder="পরিমাণ" />
                        <Input value={eReason} onChange={(e) => setEReason(e.target.value)} placeholder="কারণ" />
                        <Input type="date" value={eDate} onChange={(e) => setEDate(e.target.value)} />
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="gold" onClick={saveEdit} loading={busy}>
                          সেভ
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => void deleteTxn(t.id)} disabled={busy}>
                          মুছুন
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditId(null)} disabled={busy}>
                          বাতিল
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-4 md:p-5">
          <h2 className="mb-3 text-sm font-bold text-cream">নতুন লেনদেন</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <DirectionSeg value={tDirection} onChange={setTDirection} disabled={busy} />
            <Input inputMode="numeric" placeholder="পরিমাণ, যেমন: 3000" value={tAmount} onChange={(e) => setTAmount(e.target.value)} />
            <Input placeholder="কারণ, যেমন: আবার ধার দিলাম" value={tReason} onChange={(e) => setTReason(e.target.value)} />
            <Input type="date" value={tDate} onChange={(e) => setTDate(e.target.value)} />
          </div>
          <Button variant="gold" className="mt-3 w-full justify-center" onClick={addTxn} loading={busy}>
            লেনদেন যোগ করুন
          </Button>
          {detail.net !== 0 && (
            <p className="mt-2 text-center text-[11px] text-muted">
              টিপ: {detail.net > 0 ? 'পুরো টাকা ফেরত পেলে "টাকা নিলাম"-এ সেই অঙ্ক লিখুন — খাতা নিজেই নিষ্পত্তি দেখাবে।' : 'পুরো টাকা দিয়ে দিলে "টাকা দিলাম"-এ লিখুন — খাতা নিষ্পত্তি হবে।'}
            </p>
          )}
        </Card>
      </FinancePageChrome>
    )
  }

  /* ─────────── party list ─────────── */
  return (
    <FinancePageChrome
      title="পাওনা-দেনা"
      subtitle="আপনার ব্যক্তিগত লেনদেন — স্টাফ নয়, বাইরের ব্যক্তি/প্রতিষ্ঠান"
      hideDateFilter
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted">মোট পাওনা</p>
          <Money amount={totals.recv} className="mt-1 block text-xl font-bold text-emerald-400" />
        </Card>
        <Card className="p-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted">মোট দেনা</p>
          <Money amount={totals.pay} className="mt-1 block text-xl font-bold text-danger" />
        </Card>
        <Card className="p-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted">নিট</p>
          <p className={`mt-1 text-xl font-bold ${totals.net > 0 ? 'text-emerald-400' : totals.net < 0 ? 'text-danger' : 'text-cream'}`}>
            {totals.net < 0 ? '−' : ''}
            <Money amount={Math.abs(totals.net)} />
          </p>
        </Card>
      </div>

      <div className="flex flex-wrap gap-2">
        {(
          [
            ['all', 'সব'],
            ['recv', 'পাওনা'],
            ['pay', 'দেনা'],
            ['settled', 'নিষ্পত্তি'],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => setFilter(v)}
            className={`rounded-full px-4 py-1.5 text-xs font-bold transition ${
              filter === v ? 'bg-gold text-black shadow' : 'border border-border-strong bg-card text-muted'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <Card className="p-4 md:p-5">
        <h2 className="mb-3 text-sm font-bold text-cream">
          খাতা <span className="text-[11px] font-normal text-muted">({parties.length} জন)</span>
        </h2>
        {loading || detailLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : filteredParties.length === 0 ? (
          <Empty title="এই ফিল্টারে কেউ নেই" desc="নিচের ফর্ম থেকে নতুন খাতা খুলুন।" />
        ) : (
          <div className="divide-y divide-border-subtle">
            {filteredParties.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => void openParty(p.id)}
                className="flex w-full items-center justify-between gap-3 py-3 text-left"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-cream">{p.name}</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {p.txnCount}টি লেনদেন · শেষ: {fmtDay(p.lastTxnDate)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div className="flex flex-col items-end gap-1">
                    <span
                      className={`text-sm font-bold ${p.net > 0 ? 'text-emerald-400' : p.net < 0 ? 'text-danger' : 'text-muted'}`}
                    >
                      {p.net < 0 ? '−' : ''}
                      <Money amount={Math.abs(p.net)} />
                    </span>
                    <NetPill net={p.net} />
                  </div>
                  <span className="text-muted">›</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-4 md:p-5">
        <h2 className="mb-3 text-sm font-bold text-cream">নতুন ব্যক্তি / প্রতিষ্ঠান</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-1 block text-[11px] font-bold text-muted">নাম *</label>
            <Input placeholder="যেমন: করিম ট্রেডার্স" value={pName} onChange={(e) => setPName(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-muted">প্রথম লেনদেন *</label>
            <DirectionSeg value={pDirection} onChange={setPDirection} disabled={busy} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-muted">পরিমাণ (৳) *</label>
            <Input inputMode="numeric" placeholder="যেমন: 4000" value={pAmount} onChange={(e) => setPAmount(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-muted">কারণ *</label>
            <Input placeholder="যেমন: ধার দিলাম / ধার নিলাম" value={pReason} onChange={(e) => setPReason(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-muted">তারিখ *</label>
            <Input type="date" value={pDate} onChange={(e) => setPDate(e.target.value)} />
          </div>
        </div>
        <Button variant="gold" className="mt-4 w-full justify-center" onClick={createParty} loading={busy}>
          খাতা খুলুন
        </Button>
      </Card>
    </FinancePageChrome>
  )
}
