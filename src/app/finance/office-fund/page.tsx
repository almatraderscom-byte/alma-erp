'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { toast } from 'react-hot-toast'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { Card, KpiCard, Button, Input, Empty, Skeleton } from '@/components/ui'
import { Money } from '@/components/ui/Currency'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } }
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.35 } } }

type LedgerRow = {
  id: string
  type: string
  amount: number
  note: string | null
  refType: string | null
  refId: string | null
  createdByName: string | null
  createdAt: string
}
type FundResponse = {
  ok: boolean
  canTopUp: boolean
  summary: { businessId: string; balance: number; totalIn: number; totalOut: number; entryCount: number }
  ledger: LedgerRow[]
}

const TYPE_LABEL: Record<string, { bn: string; positive: boolean }> = {
  TOP_UP: { bn: 'টপ-আপ (যোগ)', positive: true },
  RETURN_IN: { bn: 'ফেরত (যোগ)', positive: true },
  ADVANCE_OUT: { bn: 'অ্যাডভান্স (বাদ)', positive: false },
  EXPENSE: { bn: 'খরচ (বাদ)', positive: false },
  ADJUSTMENT: { bn: 'সংশোধন', positive: true },
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-BD', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso.slice(0, 10) }
}

export default function OfficeFundPage() {
  const [data, setData] = useState<FundResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/finance/office-fund', { cache: 'no-store' })
      if (!res.ok) {
        if (res.status === 403) { toast.error('অফিস ফান্ড শুধু অ্যাডমিনদের জন্য।'); setData(null); return }
        throw new Error(`HTTP ${res.status}`)
      }
      const json = (await res.json()) as FundResponse
      setData(json)
    } catch {
      toast.error('ফান্ড লোড করা যায়নি।')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const submit = useCallback(async () => {
    const n = Number(String(amount).replace(/[^0-9.]/g, ''))
    if (!(n > 0)) { toast.error('সঠিক একটি অঙ্ক দিন।'); return }
    setSaving(true)
    const t = toast.loading('যোগ করা হচ্ছে…')
    try {
      const res = await fetch('/api/finance/office-fund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: n, note: note.trim() || undefined }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json?.message || 'failed')
      toast.success(json.message || 'যোগ হয়েছে।', { id: t })
      setAmount(''); setNote('')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'যোগ করা যায়নি।', { id: t })
    } finally {
      setSaving(false)
    }
  }, [amount, note, load])

  const s = data?.summary

  return (
    <FinancePageChrome
      title="Office Fund"
      subtitle="অফিসের চলতি ফান্ড (পেটি ক্যাশ) · ALMA Lifestyle"
      hideDateFilter
      actions={<Link href="/finance"><Button size="xs">Finance</Button></Link>}
    >
      <motion.div variants={stagger} initial="hidden" animate="show" className="min-w-0 max-w-full space-y-6">
        <motion.div variants={fadeUp} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <KpiCard label="ফান্ড ব্যালেন্স" value={s?.balance ?? 0} color="txt-pos" loading={loading} />
          <KpiCard label="মোট যোগ হয়েছে" value={s?.totalIn ?? 0} loading={loading} />
          <KpiCard label="মোট বের হয়েছে" value={s?.totalOut ?? 0} loading={loading} />
        </motion.div>

        {data?.canTopUp && (
          <motion.div variants={fadeUp}>
            <Card className="p-5 md:p-6">
              <p className="text-sm font-bold text-cream mb-1">ফান্ডে টাকা যোগ করুন</p>
              <p className="text-[11px] text-muted mb-4">শুধু মালিক ফান্ডে টাকা যোগ করতে পারেন। (আপনি নিজে বিকাশ/ক্যাশে রেখে এখানে রেকর্ড করবেন।)</p>
              <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
                <div className="flex-1">
                  <label className="block text-[11px] text-muted mb-1">টাকার অঙ্ক (৳)</label>
                  <Input inputMode="numeric" placeholder="যেমন 10000" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </div>
                <div className="flex-1">
                  <label className="block text-[11px] text-muted mb-1">নোট (ঐচ্ছিক)</label>
                  <Input placeholder="যেমন জুনের পেটি ক্যাশ" value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
                <Button variant="gold" size="md" loading={saving} onClick={submit}>যোগ করুন</Button>
              </div>
            </Card>
          </motion.div>
        )}

        <motion.div variants={fadeUp}>
          <Card className="p-5 md:p-6">
            <p className="text-sm font-bold text-cream mb-4">সাম্প্রতিক লেনদেন</p>
            {loading ? (
              <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-xl" />)}</div>
            ) : !data || data.ledger.length === 0 ? (
              <Empty title="এখনো কোনো লেনদেন নেই" desc="উপরে টাকা যোগ করে শুরু করুন।" />
            ) : (
              <div className="divide-y divide-border-subtle">
                {data.ledger.map((row) => {
                  const meta = TYPE_LABEL[row.type] ?? { bn: row.type, positive: true }
                  return (
                    <div key={row.id} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-cream">{meta.bn}</p>
                        <p className="text-[10px] text-muted truncate">
                          {fmtDate(row.createdAt)}{row.createdByName ? ` · ${row.createdByName}` : ''}{row.note ? ` · ${row.note}` : ''}
                        </p>
                      </div>
                      <span className={`shrink-0 text-sm font-bold ${meta.positive ? 'txt-pos' : 'txt-neg'}`}>
                        {meta.positive ? '+' : '−'}<Money amount={row.amount} />
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        </motion.div>
      </motion.div>
    </FinancePageChrome>
  )
}
