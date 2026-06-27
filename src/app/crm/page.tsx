'use client'
import { useDeferredValue, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSession } from 'next-auth/react'
import toast from 'react-hot-toast'
import { useCustomers } from '@/hooks/useERP'
import { useOrdersData } from '@/contexts/OrdersDataContext'
import { useBusiness } from '@/contexts/BusinessContext'
import { buildCustomerReturnInsights } from '@/lib/customer-order-insights'
import { invalidateQueryCache } from '@/hooks/useQuery'
import { normalizeAlmaRole } from '@/lib/roles'
import { PageHeader, Card, KpiCard, SegmentBadge, RiskBadge, Avatar, ClvBar, Button, SearchInput, Select, StatRow, GoldDivider, Progress, Skeleton, Empty, Money, BdtText, StatusBadge } from '@/components/ui'
import { fmt, pct } from '@/lib/utils'
import type { Customer, CustomerSegment, OrderStatus } from '@/types'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } }
const fadeUp = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.25 } } }

const SEGMENTS: CustomerSegment[] = ['VIP','REGULAR','NEW','RISKY','BLACKLIST','COLD']

export default function CrmPage() {
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [segment, setSegment] = useState('')
  const [risk, setRisk]     = useState('')
  const [selected, setSelected] = useState<Customer | null>(null)
  const [syncing, setSyncing] = useState(false)

  const { data: session } = useSession()
  const { businessId } = useBusiness()
  const role = normalizeAlmaRole(session?.user?.role)
  const canSyncFromOrders = role === 'SUPER_ADMIN'

  const { data, initialLoading, refetch } = useCustomers({ segment: segment || undefined, risk_level: risk || undefined, search: deferredSearch || undefined })
  const { orders: allOrders, enabled: ordersEnabled } = useOrdersData()
  const customers = data?.customers ?? []
  const listLoading = initialLoading && customers.length === 0

  const returnInsightsByPhone = useMemo(() => {
    if (!ordersEnabled || !allOrders.length) return new Map<string, ReturnType<typeof buildCustomerReturnInsights>>()
    const map = new Map<string, ReturnType<typeof buildCustomerReturnInsights>>()
    for (const c of customers) {
      const digits = c.phone.replace(/\D/g, '').slice(-11)
      if (!digits || map.has(digits)) continue
      map.set(digits, buildCustomerReturnInsights(allOrders, c.phone))
    }
    return map
  }, [allOrders, customers, ordersEnabled])

  function insightsForCustomer(c: Customer) {
    const digits = c.phone.replace(/\D/g, '').slice(-11)
    return returnInsightsByPhone.get(digits) ?? buildCustomerReturnInsights(allOrders, c.phone)
  }
  const summary = {
    total:         customers.length,
    total_revenue: customers.reduce((a, c) => a + (c.total_spent ?? 0), 0),
    by_segment: {
      VIP:  customers.filter(c => c.segment === 'VIP').length,
      HIGH: customers.filter(c => c.risk_level === 'HIGH').length,
    },
    avg_clv: customers.length > 0
      ? Math.round(customers.reduce((a, c) => a + (c.clv_score ?? 0), 0) / customers.length)
      : 0,
  }

  async function syncFromOrders() {
    if (!canSyncFromOrders || syncing) return
    setSyncing(true)
    try {
      const res = await fetch('/api/customers/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: businessId }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(String(json.error || 'Could not sync customers from orders'))
        return
      }
      const processed = Number(json.processed ?? 0)
      const created = Number(json.created ?? 0)
      toast.success(`Synced from orders: ${processed} processed, ${created} new profiles`)
      invalidateQueryCache('customers:')
      refetch()
    } catch (e) {
      toast.error((e as Error).message || 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="min-h-[100dvh] bg-transparent">
      <PageHeader
        title="CRM"
        subtitle={<>{summary?.total ?? 0} customers · <BdtText value={fmt(summary?.total_revenue ?? 0)} /> lifetime revenue</>}
        actions={canSyncFromOrders ? (
          <Button
            size="xs"
            variant="secondary"
            disabled={syncing}
            onClick={() => void syncFromOrders()}
          >
            {syncing ? 'Syncing…' : 'Sync from orders'}
          </Button>
        ) : undefined}
      />

      <motion.div variants={stagger} initial="hidden" animate="show" className="min-w-0 max-w-full space-y-4 px-3 py-4 pb-24 sm:px-6 md:pb-6">

        {/* KPIs */}
        <motion.div variants={fadeUp} className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <KpiCard label="Total Customers" value={summary?.total ?? 0} loading={listLoading} />
          <KpiCard label="Lifetime Revenue" value={fmt(summary?.total_revenue ?? 0)} color="text-gold-lt" loading={listLoading} />
          <KpiCard label="VIP"          value={summary?.by_segment?.VIP ?? 0}       color="text-gold"      loading={listLoading} />
          <KpiCard label="Avg CLV Score" value={`${summary?.avg_clv ?? 0}/100`}      color="text-blue-400"  loading={listLoading} />
          <KpiCard label="High Risk"     value={summary?.by_segment?.HIGH ?? (data?.customers ?? []).filter(c => c.risk_level === 'HIGH').length ?? 0} color="text-red-400" loading={listLoading} />
        </motion.div>

        {/* Segment tabs */}
        <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
          <button onClick={() => setSegment('')}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${!segment ? 'bg-gold/10 border-gold-dim/50 text-gold-lt' : 'border-border text-muted'}`}>
            All {customers.length}
          </button>
          {SEGMENTS.map(s => {
            const cnt = (data?.customers ?? []).filter(c => c.segment === s).length
            return (
              <button key={s} onClick={() => setSegment(segment === s ? '' : s)}
                className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${segment === s ? 'bg-gold/10 border-gold-dim/50 text-gold-lt' : 'border-border text-muted hover:text-muted'}`}>
                {s} <span className="opacity-60">{cnt}</span>
              </button>
            )
          })}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-2">
          <div className="flex-1 min-w-48"><SearchInput value={search} onChange={setSearch} placeholder="Search by name, phone, district…" /></div>
          <Select value={risk} onChange={setRisk} options={[{ label:'All risk levels', value:'' }, { label:'Low', value:'LOW' }, { label:'Medium', value:'MEDIUM' }, { label:'High', value:'HIGH' }]} />
        </div>

        {/* Table — desktop */}
        <Card className="hidden min-w-0 md:block">
          <div className="overflow-x-auto min-w-0 max-w-full table-scroll">
          <table className="w-full min-w-[1080px] text-xs border-collapse">
            <thead>
              <tr className="border-b border-border">
                {['Customer','District','Orders','Revenue','CLV Score','Risk','Segment','Last Order','Actions'].map(h => (
                  <th key={h} className="px-3 py-3 text-left text-[10px] font-bold tracking-[0.08em] uppercase text-muted whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {listLoading
                ? Array(5).fill(0).map((_, i) => (
                    <tr key={i} className="border-b border-border/50">
                      {Array(9).fill(0).map((__, j) => <td key={j} className="px-3 py-3.5"><div className="skeleton h-3 rounded w-full" /></td>)}
                    </tr>
                  ))
                : customers.map(c => (
                    <tr key={c.id} onClick={() => setSelected(c.id === selected?.id ? null : c)}
                      className={`border-b border-border/50 cursor-pointer transition-colors ${c.id === selected?.id ? 'bg-gold/5' : 'hover:bg-white/[0.02]'}`}>
                      <td className="px-3 py-3.5">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={c.name} vip={c.segment === 'VIP'} />
                          <div>
                            <p className="font-semibold text-cream">{c.name}</p>
                            <p className="text-[10px] text-muted-hi font-mono">{c.phone}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3.5 text-muted">{c.district}</td>
                      <td className="px-3 py-3.5 text-center">
                        <p className="font-bold text-cream">{c.total_orders}</p>
                        <p className="text-[10px] text-muted-hi">D:{c.delivered} R:{c.returned}</p>
                      </td>
                      <td className="px-3 py-3.5 font-bold text-cream tabular-nums"><Money amount={c.total_spent} /></td>
                      <td className="px-3 py-3.5 w-28"><ClvBar score={c.clv_score} /></td>
                      <td className="px-3 py-3.5">
                        <div className="flex flex-col items-start gap-1">
                          <RiskBadge level={c.risk_level} />
                          {ordersEnabled && (() => {
                            const ins = insightsForCustomer(c)
                            if (ins.returnCount === 0) return null
                            return (
                              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${
                                ins.computedRisk === 'HIGH'
                                  ? 'text-red-400 border-red-400/30 bg-red-400/10'
                                  : ins.computedRisk === 'MEDIUM'
                                    ? 'text-amber-400 border-amber-400/30 bg-amber-400/10'
                                    : 'text-muted border-border bg-card'
                              }`}>
                                {ins.returnRatePct}% returns
                              </span>
                            )
                          })()}
                        </div>
                      </td>
                      <td className="px-3 py-3.5"><SegmentBadge segment={c.segment} /></td>
                      <td className="px-3 py-3.5 text-muted">{c.last_order || '—'}</td>
                      <td className="px-3 py-3.5">
                        <div className="flex gap-1.5">
                          <a href={c.whatsapp} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
                            className="px-2 py-1 rounded-lg bg-green-400/10 border border-green-400/20 text-green-400 text-[10px] font-bold hover:bg-green-400/20 transition-colors">
                            WA
                          </a>
                          <button onClick={e => { e.stopPropagation(); setSelected(c) }}
                            className="px-2 py-1 rounded-lg bg-card border border-border text-muted text-[10px] font-bold hover:text-muted transition-colors">
                            View
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
              }
            </tbody>
          </table>
          {!listLoading && customers.length === 0 && <Empty icon="◎" title="No customers match" desc="Try a different filter" />}
          </div>
        </Card>

        {/* Mobile cards */}
        <div className="md:hidden space-y-2">
          {listLoading ? Array(4).fill(0).map((_, i) => <div key={i} className="skeleton h-24 rounded-xl" />) : customers.map(c => (
            <button key={c.id} className="w-full text-left" onClick={() => setSelected(c.id === selected?.id ? null : c)}>
              <Card className={`p-4 ${c.id === selected?.id ? 'border-gold-dim/50' : ''}`}>
                <div className="flex items-center gap-3 mb-3">
                  <Avatar name={c.name} vip={c.segment === 'VIP'} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-cream">{c.name}</p>
                    <p className="text-[11px] text-muted">{c.district} · {c.phone}</p>
                  </div>
                  <SegmentBadge segment={c.segment} />
                </div>
                <div className="grid grid-cols-3 gap-2 mb-2 text-center">
                  <div><p className="text-sm font-bold text-cream">{c.total_orders}</p><p className="text-[10px] text-muted-hi">Orders</p></div>
                  <div><p className="text-sm font-bold text-gold"><Money amount={c.total_spent} /></p><p className="text-[10px] text-muted-hi">Spent</p></div>
                  <div><p className="text-sm font-bold text-cream">{c.clv_score}</p><p className="text-[10px] text-muted-hi">CLV</p></div>
                </div>
                <ClvBar score={c.clv_score} />
              </Card>
            </button>
          ))}
          {!listLoading && customers.length === 0 && <Empty icon="◎" title="No customers match" />}
        </div>

      </motion.div>

      {/* Detail drawer */}
      <AnimatePresence>
        {selected && (
          <motion.div className="fixed inset-0 z-50 flex justify-end" initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setSelected(null)} />
            <motion.div className="relative w-full max-w-md bg-surface border-l border-border h-full overflow-y-auto scrollbar-gold"
              initial={{ x:'100%' }} animate={{ x:0 }} exit={{ x:'100%' }} transition={{ type:'spring', damping:26, stiffness:300 }}>
              <div className="sticky top-0 bg-surface/95 backdrop-blur border-b border-border px-5 py-4 flex items-center gap-3 z-10">
                <Avatar name={selected.name} size="md" vip={selected.segment === 'VIP'} />
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-cream">{selected.name}</p>
                  <p className="text-[11px] text-muted">{selected.id} · {selected.district}</p>
                </div>
                <button onClick={() => setSelected(null)} className="text-muted hover:text-cream transition-colors text-lg">×</button>
              </div>
              <div className="p-5 space-y-5">
                <div className="flex gap-2 flex-wrap">
                  <SegmentBadge segment={selected.segment} />
                  <RiskBadge level={selected.risk_level} />
                  {ordersEnabled && (() => {
                    const ins = insightsForCustomer(selected)
                    const escalated = ins.computedRisk === 'HIGH' || (ins.computedRisk === 'MEDIUM' && selected.risk_level === 'LOW')
                    if (!escalated && ins.returnCount === 0) return null
                    return (
                      <span className={`text-[10px] px-2 py-1 rounded-full font-bold border ${
                        ins.computedRisk === 'HIGH'
                          ? 'bg-red-400/10 text-red-400 border-red-400/30'
                          : 'bg-amber-400/10 text-amber-300 border-amber-400/30'
                      }`}>
                        Return risk: {ins.computedRisk}
                        {ins.returnsLast30Days > 0 ? ` · ${ins.returnsLast30Days} in 30d` : ''}
                      </span>
                    )
                  })()}
                  {selected.wa_optin === 'Yes' && <span className="text-[10px] bg-green-400/10 text-green-400 border border-green-400/20 px-2 py-1 rounded-full font-bold">WA Opt-in</span>}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-card rounded-xl p-3 text-center"><p className="text-base font-bold text-gold"><Money amount={selected.total_spent} /></p><p className="text-[10px] text-muted">Lifetime Spend</p></div>
                  <div className="bg-card rounded-xl p-3 text-center"><p className="text-base font-bold text-green-400"><Money amount={selected.total_profit} /></p><p className="text-[10px] text-muted">Lifetime Profit</p></div>
                  <div className="bg-card rounded-xl p-3 text-center"><p className="text-base font-bold text-cream">{selected.delivered}/{selected.total_orders}</p><p className="text-[10px] text-muted">Delivered</p></div>
                  <div className="bg-card rounded-xl p-3 text-center"><p className="text-base font-bold text-gold">{selected.loyalty_pts} pts</p><p className="text-[10px] text-muted">Loyalty</p></div>
                </div>
                <GoldDivider />
                <div>
                  <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-muted mb-3">Risk Intelligence</p>
                  <div className="bg-card rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between text-xs mb-1"><span className="text-muted">Risk Score</span><span className={`font-bold ${selected.risk_score > 60 ? 'text-red-400' : selected.risk_score > 30 ? 'text-amber-400' : 'text-green-400'}`}>{selected.risk_score}/100</span></div>
                    <Progress value={selected.risk_score} color={selected.risk_score > 60 ? 'bg-red-400' : selected.risk_score > 30 ? 'bg-amber-400' : 'bg-green-400'} />
                    <StatRow label="COD Fail Rate" value={pct(selected.cod_fail_pct * 100)} valueClass={selected.cod_fail_pct > 0.5 ? 'text-red-400' : 'text-green-400'} />
                    <StatRow
                      label="Return Rate (sheet)"
                      value={pct(selected.return_rate * 100)}
                      valueClass={selected.return_rate > 0.3 ? 'text-red-400' : 'text-green-400'}
                    />
                    {ordersEnabled && (() => {
                      const ins = insightsForCustomer(selected)
                      return (
                        <>
                          <StatRow label="Return Rate (orders)" value={`${ins.returnRatePct}%`} valueClass={ins.returnRatePct > 30 ? 'text-red-400' : 'text-cream'} />
                          <StatRow label="Return Loss (orders)" value={fmt(ins.totalReturnLoss)} valueClass={ins.totalReturnLoss > 0 ? 'text-red-400' : 'text-green-400'} />
                        </>
                      )
                    })()}
                    <StatRow label="CLV Score" value={`${selected.clv_score}/100`} valueClass="text-gold" />
                    <StatRow label="Days Inactive" value={selected.days_inactive} valueClass={selected.days_inactive > 90 ? 'text-amber-400' : 'text-cream'} />
                  </div>
                </div>
                {ordersEnabled && (() => {
                  const ins = insightsForCustomer(selected)
                  if (!ins.recentOrders.length) return null
                  return (
                    <div>
                      <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-muted mb-3">Recent Orders</p>
                      <div className="bg-card rounded-xl p-4 space-y-2">
                        {ins.recentOrders.map(o => (
                          <div key={o.id} className="flex items-center justify-between gap-2 text-xs border-b border-border/40 pb-2 last:border-0 last:pb-0">
                            <div className="min-w-0">
                              <p className="font-mono text-[10px] text-gold">{o.id}</p>
                              <p className="text-muted">{o.date}</p>
                            </div>
                            <div className="text-right shrink-0">
                              <StatusBadge status={o.status as OrderStatus} />
                              {o.isReturn && o.returnLoss > 0 && (
                                <p className="text-[10px] text-red-400 mt-0.5">−<Money amount={o.returnLoss} /></p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })()}
                <div>
                  <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-muted mb-3">Profile</p>
                  <div className="bg-card rounded-xl p-4">
                    <StatRow label="Phone"    value={selected.phone} />
                    <StatRow label="Address"  value={selected.address} />
                    <StatRow label="Source"   value={selected.source} />
                    <StatRow label="Fav Cat." value={selected.fav_category || '—'} />
                    <StatRow label="Last Order" value={selected.last_order || '—'} />
                    {selected.notes && <StatRow label="Notes" value={selected.notes} valueClass="text-amber-400" />}
                  </div>
                </div>
                <div className="flex gap-2">
                  <a href={selected.whatsapp} target="_blank" rel="noreferrer" className="flex-1">
                    <Button variant="gold" className="w-full justify-center">Send WhatsApp</Button>
                  </a>
                  <Button variant="ghost" className="flex-1 justify-center">View Orders</Button>
                  {selected.segment === 'RISKY' && <Button variant="danger">Flag</Button>}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  )
}
