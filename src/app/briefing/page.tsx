'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import Link from 'next/link'
import { Button, Card, Empty, KpiCard, PageHeader, Skeleton } from '@/components/ui'
import { useCountUp } from '@/components/ui'
import { safeFetchJson } from '@/lib/safe-fetch'
import { useRegisterMobileRefresh } from '@/hooks/useRegisterMobileRefresh'
import { cn } from '@/lib/utils'

// ── Types (structural — the API merges OwnerBriefingData + digest extras) ──────
type Urgency = 'high' | 'normal'
type Decision = { area: string; urgency: Urgency; text: string; recommend: string; knowledgeNote?: string }
type Reorder = { id: string; name: string; reason: string; suggestedQty: number; urgency: Urgency; daysOfStock?: number }
type Briefing = {
  today?: string
  sales: { yesterdayTotal: number; yesterdayOrders: number; sevenDayAvg: number; sevenDayOrderAvg: number } | null
  pendingOrders: { count: number; mismatch?: boolean; note?: string | null } | null
  inventory: { items: Array<{ name: string; currentStock: number; reorderLevel: number; sku: string }> } | null
  reorderSuggestions: Reorder[]
  csWaiting: { unrepliedCount: number; nearWindowCount: number; openAlerts: number } | null
  adsDigest: { campaigns: Array<{ name: string; spend: number; ctr: number; cpc: number }>; anomalies: Array<{ campaign: string; dropPct: number }> } | null
  staffYesterday: { summary: string; done: number; total: number; lowPerformers: Array<{ name: string; pct: number; daysLow: number }> } | null
  staffPatterns: Array<{ name: string; type: string; detail: string }>
  returns: { flags: string[]; totalReturns: number; returnRatePct: number | null } | null
  pricing: { flags: string[]; costDataMissing: boolean } | null
  decisions: Decision[]
  generatedAt?: string
  pendingApprovalsCount?: number
  openTodos?: Array<{ title: string; priority: string; ageDays: number }>
  lingeringTodos?: Array<{ title: string; ageDays: number }>
}

const AREA: Record<string, { icon: string; label: string }> = {
  stock: { icon: '📦', label: 'স্টক' },
  sales: { icon: '💰', label: 'বিক্রি' },
  orders: { icon: '🛒', label: 'অর্ডার' },
  customers: { icon: '👥', label: 'কাস্টমার' },
  ads: { icon: '📣', label: 'অ্যাড' },
  staff: { icon: '👷', label: 'স্টাফ' },
  returns: { icon: '↩️', label: 'রিটার্ন' },
  pricing: { icon: '🏷️', label: 'প্রাইসিং' },
  marketing: { icon: '✨', label: 'মার্কেটিং' },
}

function tk(n: number | null | undefined) {
  return `৳${Math.round(Number(n || 0)).toLocaleString('en-BD')}`
}

function greeting() {
  // Dhaka-hour greeting for the owner.
  const h = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka', hour: '2-digit', hour12: false }))
  if (h < 12) return 'শুভ সকাল'
  if (h < 17) return 'শুভ অপরাহ্ন'
  if (h < 20) return 'শুভ সন্ধ্যা'
  return 'শুভ রাত্রি'
}

function relTime(iso?: string) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.round(diff / 60000)
  if (m < 1) return 'এইমাত্র'
  if (m < 60) return `${m} মিনিট আগে`
  const hh = Math.round(m / 60)
  if (hh < 24) return `${hh} ঘণ্টা আগে`
  return `${Math.round(hh / 24)} দিন আগে`
}

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.35 } } }

export default function BriefingPage() {
  const [data, setData] = useState<Briefing | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (fresh = false) => {
    if (fresh) setRefreshing(true)
    else setLoading(true)
    const res = await safeFetchJson<Briefing>(`/api/briefing${fresh ? '?refresh=1' : ''}`, { cache: 'no-store' })
    if (res.ok) {
      setData(res.data)
      setError(null)
    } else {
      setError(res.error.message || 'ব্রিফিং লোড করা গেল না')
    }
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => { void load(false) }, [load])
  useRegisterMobileRefresh(useCallback(() => { void load(true) }, [load]))

  const highDecisions = useMemo(() => (data?.decisions ?? []).filter(d => d.urgency === 'high'), [data])
  const normalDecisions = useMemo(() => (data?.decisions ?? []).filter(d => d.urgency !== 'high'), [data])
  const decisions = useMemo(() => [...highDecisions, ...normalDecisions], [highDecisions, normalDecisions])

  return (
    <div className="mx-auto w-full max-w-4xl px-3 pb-24 pt-3 sm:px-4 sm:pb-10">
      <PageHeader
        title="Morning Briefing"
        subtitle="আপনার ব্যবসার আজকের ছবি — এক নজরে"
        actions={
          <Button variant="gold" size="sm" loading={refreshing} onClick={() => void load(true)}>
            {refreshing ? 'রিফ্রেশ হচ্ছে…' : '↻ রিফ্রেশ'}
          </Button>
        }
      />

      {loading && !data ? (
        <BriefingSkeleton />
      ) : error ? (
        <Card className="p-6">
          <Empty title="ব্রিফিং লোড করা গেল না" desc={error} action={<Button variant="gold" size="sm" onClick={() => void load(true)}>আবার চেষ্টা করুন</Button>} />
        </Card>
      ) : data ? (
        <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-4">
          {/* Hero greeting */}
          <motion.div variants={fadeUp}>
            <Card gold className="relative overflow-hidden p-5 sm:p-6">
              <div className="pointer-events-none absolute -right-10 -top-12 h-40 w-40 rounded-full bg-gold/10 blur-3xl" />
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-gold">{greeting()}, Boss</p>
              <h2 className="mt-1 text-xl font-black text-cream sm:text-2xl">আজকের ব্যবসা ব্রিফিং</h2>
              <p className="mt-1.5 text-[11px] text-muted">
                {data.generatedAt ? `আপডেট: ${relTime(data.generatedAt)}` : ''}
                {decisions.length ? ` · ${decisions.length}টি করণীয়` : ' · সব ঠিক আছে ✓'}
              </p>
            </Card>
          </motion.div>

          {/* KPI row */}
          <motion.div variants={fadeUp} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard
              label="গতকালের বিক্রি"
              value={data.sales?.yesterdayTotal ?? 0}
              valueKind="currency"
              animate
              color="text-gold-lt"
              sub={data.sales ? `${data.sales.yesterdayOrders} অর্ডার` : 'ডেটা নেই'}
            />
            <KpiCard
              label="৭-দিন গড়/দিন"
              value={data.sales?.sevenDayAvg ?? 0}
              valueKind="currency"
              animate
              sub={data.sales ? `${data.sales.sevenDayOrderAvg} অর্ডার/দিন` : '—'}
            />
            <KpiCard
              label="পেন্ডিং অর্ডার"
              value={data.pendingOrders?.count ?? 0}
              valueKind="number"
              animate
              color={(data.pendingOrders?.count ?? 0) >= 10 ? 'text-danger' : 'text-cream'}
              sub={data.pendingOrders?.mismatch ? '⚠️ sync mismatch' : 'অপেক্ষমাণ'}
            />
            <KpiCard
              label="অনুমোদন বাকি"
              value={data.pendingApprovalsCount ?? 0}
              valueKind="number"
              animate
              color={(data.pendingApprovalsCount ?? 0) > 0 ? 'text-gold-lt' : 'text-cream'}
              sub="approvals"
            />
          </motion.div>

          {/* Today's actions — the centerpiece */}
          <motion.section variants={fadeUp}>
            <SectionTitle icon="🎯" title="আজকের করণীয়" count={decisions.length} />
            {decisions.length === 0 ? (
              <Card className="p-6">
                <Empty title="সব শান্ত ✓" desc="জরুরি কোনো সিদ্ধান্ত নেই — ব্যবসা স্বাভাবিক চলছে, Boss।" />
              </Card>
            ) : (
              <div className="space-y-2.5">
                {decisions.map((d, i) => <DecisionCard key={i} d={d} />)}
              </div>
            )}
          </motion.section>

          {/* Reorder suggestions */}
          {(data.reorderSuggestions?.length ?? 0) > 0 && (
            <motion.section variants={fadeUp}>
              <SectionTitle icon="📦" title="রিঅর্ডার দরকার" count={data.reorderSuggestions.length} href="/inventory" />
              <div className="grid gap-2.5 sm:grid-cols-2">
                {data.reorderSuggestions.slice(0, 6).map(r => (
                  <Card key={r.id} className={cn('p-3.5', r.urgency === 'high' && 'border-danger/35')}>
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-bold text-cream">{r.name}</p>
                      <span className={cn(
                        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black',
                        r.urgency === 'high' ? 'bg-danger/15 text-danger' : 'bg-gold/15 text-gold-lt',
                      )}>
                        {r.urgency === 'high' ? 'জরুরি' : 'শীঘ্রই'}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-hi">{r.reason}</p>
                    <p className="mt-2 text-[12px] font-bold text-gold-lt">~{r.suggestedQty}টি রিঅর্ডার করুন</p>
                  </Card>
                ))}
              </div>
            </motion.section>
          )}

          {/* Two-column lower grid */}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* CS waiting */}
            {data.csWaiting && (data.csWaiting.unrepliedCount || data.csWaiting.nearWindowCount || data.csWaiting.openAlerts) ? (
              <motion.div variants={fadeUp}>
                <SectionTitle icon="💬" title="কাস্টমার অপেক্ষমাণ" />
                <Card className="space-y-2.5 p-4">
                  <MiniRow label="অপেক্ষমাণ রিপ্লাই" value={data.csWaiting.unrepliedCount} tone={data.csWaiting.unrepliedCount >= 5 ? 'warn' : 'normal'} />
                  <MiniRow label="২৪ঘ window প্রায় শেষ" value={data.csWaiting.nearWindowCount} tone={data.csWaiting.nearWindowCount > 0 ? 'danger' : 'normal'} />
                  <MiniRow label="খোলা alert" value={data.csWaiting.openAlerts} tone={data.csWaiting.openAlerts > 0 ? 'warn' : 'normal'} />
                </Card>
              </motion.div>
            ) : null}

            {/* Staff yesterday */}
            {data.staffYesterday ? (
              <motion.div variants={fadeUp}>
                <SectionTitle icon="👷" title="স্টাফ (গতকাল)" />
                <Card className="space-y-2.5 p-4">
                  <MiniRow label="কাজ শেষ" value={`${data.staffYesterday.done}/${data.staffYesterday.total}`} tone="normal" />
                  {data.staffYesterday.lowPerformers.length === 0 ? (
                    <p className="text-[11px] text-success">সবাই ভালো করছে ✓</p>
                  ) : (
                    data.staffYesterday.lowPerformers.slice(0, 4).map((p, i) => (
                      <div key={i} className="flex items-center justify-between text-[11px]">
                        <span className="text-muted-hi">{p.name}</span>
                        <span className="font-bold text-danger">{p.pct}% · {p.daysLow} দিন কম</span>
                      </div>
                    ))
                  )}
                </Card>
              </motion.div>
            ) : null}

            {/* Returns & pricing */}
            {(data.returns?.flags?.length || data.pricing?.flags?.length) ? (
              <motion.div variants={fadeUp}>
                <SectionTitle icon="↩️" title="রিটার্ন ও প্রাইসিং" />
                <Card className="space-y-2 p-4">
                  {data.returns?.flags?.map((f, i) => <FlagLine key={`r${i}`} text={f} />)}
                  {data.pricing?.flags?.map((f, i) => <FlagLine key={`p${i}`} text={f} />)}
                </Card>
              </motion.div>
            ) : null}

            {/* Ads digest */}
            {data.adsDigest?.campaigns?.length ? (
              <motion.div variants={fadeUp}>
                <SectionTitle icon="📣" title="আজকের অ্যাড" />
                <Card className="space-y-2.5 p-4">
                  {data.adsDigest.campaigns.slice(0, 4).map((c, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="min-w-0 flex-1 truncate text-muted-hi">{c.name}</span>
                      <span className="shrink-0 font-mono text-cream">{tk(c.spend)} · CTR {c.ctr}%</span>
                    </div>
                  ))}
                  {data.adsDigest.anomalies?.slice(0, 2).map((a, i) => (
                    <FlagLine key={`a${i}`} text={`${a.campaign}: CTR গড়ের ${a.dropPct}% নিচে`} />
                  ))}
                </Card>
              </motion.div>
            ) : null}
          </div>

          {/* Todos */}
          {(data.openTodos?.length ?? 0) > 0 && (
            <motion.section variants={fadeUp}>
              <SectionTitle icon="📝" title="আপনার টু-ডু" count={data.openTodos!.length} />
              <Card className="divide-y divide-border-subtle p-0">
                {data.openTodos!.slice(0, 8).map((t, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', t.priority === 'high' ? 'bg-danger' : 'bg-gold')} />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-cream">{t.title}</span>
                    {t.ageDays >= 3 && <span className="shrink-0 text-[10px] font-bold text-danger">{t.ageDays} দিন</span>}
                  </div>
                ))}
              </Card>
            </motion.section>
          )}

          <p className="pt-2 text-center text-[10px] text-muted">
            ব্রিফিং তৈরি করেছে ALMA Agent · {data.generatedAt ? relTime(data.generatedAt) : ''}
          </p>
        </motion.div>
      ) : null}
    </div>
  )
}

function SectionTitle({ icon, title, count, href }: { icon: string; title: string; count?: number; href?: string }) {
  return (
    <div className="mb-2.5 flex items-center justify-between">
      <h3 className="flex items-center gap-2 text-[13px] font-black tracking-wide text-cream">
        <span className="text-base">{icon}</span>
        {title}
        {count != null && count > 0 && (
          <span className="rounded-full bg-gold/15 px-1.5 py-0.5 text-[10px] font-bold text-gold-lt">{count}</span>
        )}
      </h3>
      {href && <Link prefetch href={href} className="text-[11px] font-semibold text-gold-lt">দেখুন →</Link>}
    </div>
  )
}

function DecisionCard({ d }: { d: Decision }) {
  const meta = AREA[d.area] ?? { icon: '•', label: d.area }
  const high = d.urgency === 'high'
  return (
    <Card className={cn('p-4', high && 'border-danger/35 shadow-[0_0_18px_rgb(var(--c-accent)/0.10)]')}>
      <div className="flex items-start gap-3">
        <span className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-base',
          high ? 'bg-danger/15' : 'bg-gold/10',
        )}>{meta.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-wider text-muted">{meta.label}</span>
            {high && <span className="rounded-full bg-danger/15 px-1.5 py-0.5 text-[9px] font-black text-danger">জরুরি</span>}
          </div>
          <p className="mt-1 text-[13px] font-semibold leading-relaxed text-cream">{d.text}</p>
          <p className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-relaxed text-gold-lt">
            <span className="mt-0.5 shrink-0">→</span>
            <span>{d.recommend}</span>
          </p>
          {d.knowledgeNote && (
            <p className="mt-1.5 rounded-lg border border-border-subtle bg-bg-2/50 px-2.5 py-1.5 text-[10.5px] italic text-muted">
              💡 {d.knowledgeNote}
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}

function MiniRow({ label, value, tone }: { label: string; value: number | string; tone: 'normal' | 'warn' | 'danger' }) {
  const n = typeof value === 'number' ? value : 0
  const animated = useCountUp(n, typeof value === 'number')
  const color = tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-gold-lt' : 'text-cream'
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-muted-hi">{label}</span>
      <span className={cn('text-sm font-black tabular-nums', color)}>{typeof value === 'number' ? animated : value}</span>
    </div>
  )
}

function FlagLine({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-hi">
      <span className="mt-0.5 shrink-0 text-gold-lt">▸</span>
      <span>{text}</span>
    </p>
  )
}

function BriefingSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-28 w-full" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
      </div>
      <Skeleton className="h-5 w-40" />
      {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
    </div>
  )
}
