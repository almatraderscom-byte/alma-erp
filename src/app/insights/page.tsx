'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Button, Card, Empty, KpiCard, PageHeader, Skeleton } from '@/components/ui'
import { safeFetchJson } from '@/lib/safe-fetch'
import { useRegisterMobileRefresh } from '@/hooks/useRegisterMobileRefresh'
import { cn } from '@/lib/utils'

type Urgency = 'high' | 'normal'
type Reorder = { id: string; name: string; currentStock: number; daysOfStock: number; suggestedQty: number; urgency: Urgency; reason: string }
type SlowMover = { id: string; name: string; currentStock: number; sales90d: number }
type ProductRow = { product: string; revenue: number; units: number; marginPct: number | null; flag: string | null }
type Customer = {
  id: string; name?: string | null; phone?: string | null; ordersCount: number
  churnRisk: 'low' | 'medium' | 'high'; tier: 'vip' | 'regular' | 'occasional' | 'new'
  daysSinceLast?: number | null; estimatedClv?: number; engagementSuggestion: string; clvNote?: string
}
type Insights = {
  reorder: Reorder[]
  slowMovers: SlowMover[]
  finance: {
    period: string; revenue: number; expensesTotal: number; adSpend: number
    grossProfit: number | null; netProfit: number | null; marginPct: number | null
    revenueWoW: number | null; expenseWoW: number | null; flags: string[]; costDataMissing: boolean
    topProducts: ProductRow[]
  } | null
  customers: {
    vipCount: number; highChurnCount: number; newThisWeekCount: number
    highChurn: Customer[]; topVips: Customer[]; notes: string[]
  } | null
  generatedAt?: string
}

function tk(n: number | null | undefined) {
  return `৳${Math.round(Number(n || 0)).toLocaleString('en-BD')}`
}

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.35 } } }

export default function InsightsPage() {
  const [data, setData] = useState<Insights | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (fresh = false) => {
    if (fresh) setRefreshing(true); else setLoading(true)
    const res = await safeFetchJson<Insights>(`/api/insights${fresh ? '?refresh=1' : ''}`, { cache: 'no-store' })
    if (res.ok) { setData(res.data); setError(null) }
    else setError(res.error.message || 'ইনসাইট লোড করা গেল না')
    setLoading(false); setRefreshing(false)
  }, [])

  useEffect(() => { void load(false) }, [load])
  useRegisterMobileRefresh(useCallback(() => { void load(true) }, [load]))

  return (
    <div className="mx-auto w-full max-w-5xl px-3 pb-24 pt-3 sm:px-4 sm:pb-10">
      <PageHeader
        title="Business Insights"
        subtitle="রিঅর্ডার · ফিনান্সিয়াল হেলথ · কাস্টমার — গভীর বিশ্লেষণ"
        actions={
          <Button variant="gold" size="sm" loading={refreshing} onClick={() => void load(true)}>
            {refreshing ? 'রিফ্রেশ হচ্ছে…' : '↻ রিফ্রেশ'}
          </Button>
        }
      />

      {loading && !data ? (
        <InsightsSkeleton />
      ) : error ? (
        <Card className="p-6">
          <Empty title="ইনসাইট লোড করা গেল না" desc={error} action={<Button variant="gold" size="sm" onClick={() => void load(true)}>আবার চেষ্টা</Button>} />
        </Card>
      ) : data ? (
        <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-5">
          {/* Financial Health */}
          <motion.section variants={fadeUp}>
            <SectionTitle icon="💰" title="ফিনান্সিয়াল হেলথ" sub={data.finance?.period} />
            {data.finance ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <KpiCard label="রেভিনিউ (৩০দিন)" value={data.finance.revenue} valueKind="currency" animate color="text-gold-lt"
                    sub={<TrendSub pct={data.finance.revenueWoW} goodUp />} />
                  <KpiCard label="খরচ (৩০দিন)" value={data.finance.expensesTotal} valueKind="currency" animate
                    sub={<TrendSub pct={data.finance.expenseWoW} goodUp={false} />} />
                  <KpiCard label="নেট প্রফিট" value={data.finance.netProfit ?? 0} valueKind="currency" animate
                    color={(data.finance.netProfit ?? 0) >= 0 ? 'text-success' : 'text-danger'}
                    sub={data.finance.costDataMissing ? 'cost ডেটা অসম্পূর্ণ' : 'আনুমানিক'} />
                  <KpiCard label="মার্জিন" value={data.finance.marginPct != null ? `${data.finance.marginPct}%` : '—'}
                    color={(data.finance.marginPct ?? 0) >= 0 ? 'text-cream' : 'text-danger'} sub="net margin" />
                </div>
                {data.finance.flags.length > 0 && (
                  <Card className="space-y-1.5 p-4">
                    {data.finance.flags.map((f, i) => <FlagLine key={i} text={f} />)}
                  </Card>
                )}
                {data.finance.topProducts.length > 0 && (
                  <Card className="p-0">
                    <p className="border-b border-border-subtle px-4 py-2.5 text-[11px] font-black uppercase tracking-wider text-muted">টপ প্রোডাক্ট (প্রফিট)</p>
                    <div className="divide-y divide-border-subtle">
                      {data.finance.topProducts.map((p, i) => (
                        <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-cream">{p.product}</span>
                          <span className="shrink-0 text-[11px] text-muted">{p.units} pcs</span>
                          <span className="shrink-0 font-mono text-[12px] font-bold text-gold-lt">{tk(p.revenue)}</span>
                          {p.marginPct != null && (
                            <span className={cn('shrink-0 text-[11px] font-bold tabular-nums', p.marginPct >= 0 ? 'text-success' : 'text-danger')}>{p.marginPct}%</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
              </div>
            ) : (
              <Card className="p-6"><Empty title="ফিনান্সিয়াল ডেটা নেই" desc="এই মুহূর্তে হিসাব আনা গেল না — রিফ্রেশ করে দেখুন।" /></Card>
            )}
          </motion.section>

          {/* Reorder + Slow movers */}
          <div className="grid gap-5 lg:grid-cols-2">
            <motion.section variants={fadeUp}>
              <SectionTitle icon="📦" title="রিঅর্ডার দরকার" count={data.reorder.length} />
              {data.reorder.length === 0 ? (
                <Card className="p-6"><Empty title="স্টক ঠিক আছে ✓" desc="জরুরি রিঅর্ডার নেই, Boss।" /></Card>
              ) : (
                <div className="space-y-2.5">
                  {data.reorder.slice(0, 8).map(r => (
                    <Card key={r.id} className={cn('p-3.5', r.urgency === 'high' && 'border-danger/35')}>
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 flex-1 truncate text-sm font-bold text-cream">{r.name}</p>
                        <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black',
                          r.urgency === 'high' ? 'bg-danger/15 text-danger' : 'bg-gold/15 text-gold-lt')}>
                          {r.urgency === 'high' ? 'জরুরি' : 'শীঘ্রই'}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-muted-hi">{r.reason}</p>
                      <div className="mt-2 flex items-center justify-between">
                        <span className="text-[11px] text-muted">স্টক {r.currentStock} · ~{Math.round(r.daysOfStock)} দিন বাকি</span>
                        <span className="text-[12px] font-bold text-gold-lt">~{r.suggestedQty}টি অর্ডার</span>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </motion.section>

            <motion.section variants={fadeUp}>
              <SectionTitle icon="🐌" title="স্লো-মুভিং স্টক" count={data.slowMovers.length} />
              {data.slowMovers.length === 0 ? (
                <Card className="p-6"><Empty title="সব নড়ছে ✓" desc="পুঁজি আটকে নেই — সব স্টক বিক্রি হচ্ছে।" /></Card>
              ) : (
                <Card className="p-0">
                  <p className="border-b border-border-subtle px-4 py-2.5 text-[11px] text-muted">৩০ দিনে বিক্রি নেই — পুঁজি আটকে আছে</p>
                  <div className="divide-y divide-border-subtle">
                    {data.slowMovers.map(s => (
                      <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-cream">{s.name}</span>
                        <span className="shrink-0 text-[11px] text-muted">৯০দিনে {s.sales90d}</span>
                        <span className="shrink-0 rounded-full bg-bg-2 px-2 py-0.5 text-[11px] font-bold text-muted-hi">{s.currentStock} pcs</span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </motion.section>
          </div>

          {/* Customers */}
          <motion.section variants={fadeUp}>
            <SectionTitle icon="👥" title="কাস্টমার ইন্টেলিজেন্স" />
            {data.customers ? (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <KpiCard label="VIP কাস্টমার" value={data.customers.vipCount} valueKind="number" animate color="text-gold-lt" sub="top tier" />
                  <KpiCard label="চার্ন ঝুঁকি" value={data.customers.highChurnCount} valueKind="number" animate
                    color={data.customers.highChurnCount > 0 ? 'text-danger' : 'text-cream'} sub="হারানোর ঝুঁকি" />
                  <KpiCard label="নতুন (এই সপ্তাহ)" value={data.customers.newThisWeekCount} valueKind="number" animate color="text-success" sub="new" />
                </div>
                <div className="grid gap-3 lg:grid-cols-2">
                  {data.customers.highChurn.length > 0 && (
                    <Card className="p-0">
                      <p className="border-b border-border-subtle px-4 py-2.5 text-[11px] font-black uppercase tracking-wider text-danger">⚠ ফিরিয়ে আনুন</p>
                      <div className="divide-y divide-border-subtle">
                        {data.customers.highChurn.map(c => <CustomerRow key={c.id} c={c} />)}
                      </div>
                    </Card>
                  )}
                  {data.customers.topVips.length > 0 && (
                    <Card className="p-0">
                      <p className="border-b border-border-subtle px-4 py-2.5 text-[11px] font-black uppercase tracking-wider text-gold-lt">⭐ টপ VIP</p>
                      <div className="divide-y divide-border-subtle">
                        {data.customers.topVips.map(c => <CustomerRow key={c.id} c={c} vip />)}
                      </div>
                    </Card>
                  )}
                </div>
              </div>
            ) : (
              <Card className="p-6"><Empty title="কাস্টমার ডেটা নেই" desc="বিশ্লেষণ আনা গেল না — রিফ্রেশ করে দেখুন।" /></Card>
            )}
          </motion.section>

          <p className="pt-2 text-center text-[10px] text-muted">
            ALMA Agent বিশ্লেষণ · ৩০ দিনের ডেটা
          </p>
        </motion.div>
      ) : null}
    </div>
  )
}

function SectionTitle({ icon, title, count, sub }: { icon: string; title: string; count?: number; sub?: string }) {
  return (
    <div className="mb-2.5 flex items-baseline gap-2">
      <h3 className="flex items-center gap-2 text-[13px] font-black tracking-wide text-cream">
        <span className="text-base">{icon}</span>{title}
        {count != null && count > 0 && <span className="rounded-full bg-gold/15 px-1.5 py-0.5 text-[10px] font-bold text-gold-lt">{count}</span>}
      </h3>
      {sub && <span className="text-[10px] text-muted">{sub}</span>}
    </div>
  )
}

function TrendSub({ pct, goodUp }: { pct: number | null; goodUp: boolean }) {
  if (pct == null) return <span className="text-muted">WoW —</span>
  const up = pct >= 0
  const good = up === goodUp
  return (
    <span className={cn('font-bold', good ? 'text-success' : 'text-danger')}>
      {up ? '↑' : '↓'} {Math.abs(pct)}% WoW
    </span>
  )
}

function CustomerRow({ c, vip }: { c: Customer; vip?: boolean }) {
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-cream">{c.name || c.phone || 'কাস্টমার'}</span>
        <span className="shrink-0 text-[10px] text-muted">{c.ordersCount} অর্ডার</span>
        {vip && c.estimatedClv ? (
          <span className="shrink-0 text-[11px] font-bold text-gold-lt">{tk(c.estimatedClv)}</span>
        ) : c.daysSinceLast != null ? (
          <span className="shrink-0 text-[11px] font-bold text-danger">{c.daysSinceLast}দিন আগে</span>
        ) : null}
      </div>
      <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted-hi">{c.engagementSuggestion}</p>
    </div>
  )
}

function FlagLine({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-hi">
      <span className="mt-0.5 shrink-0 text-gold-lt">▸</span><span>{text}</span>
    </p>
  )
}

function InsightsSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-5 w-44" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  )
}
