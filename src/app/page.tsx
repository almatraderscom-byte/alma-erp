'use client'
import { useMemo } from 'react'
import dynamic from 'next/dynamic'
import { motion } from 'framer-motion'
import { useOrdersData } from '@/contexts/OrdersDataContext'
import { useDateRange } from '@/contexts/DateRangeContext'
import { DateRangeFilter } from '@/components/date-filter/DateRangeFilter'
import { aggregateDashboardMetrics } from '@/lib/order-analytics'
import { formatGroupSizeLine } from '@/lib/product-size-breakdown'
import { Card, KpiCard, Skeleton, StatusBadge, PageHeader, Empty, Money, BdtText } from '@/components/ui'
import { ConnectionStatus } from '@/components/ui/ConnectionStatus'
import { fmt, fmtNum, pct } from '@/lib/utils'
import type { Order } from '@/types'
import { useBusiness } from '@/contexts/BusinessContext'

const TradingDashboard = dynamic(() => import('@/app/trading/page'), {
  ssr: false,
  loading: () => <Skeleton className="m-4 h-80 md:m-8" />,
})

const PALETTE = ['#E07A5F', '#C45A3C', '#F4A28C', '#D4956A', '#81B29A']
const chartFallback = () => <Skeleton className="h-48 w-full rounded-xl" />
const RevenueChart = dynamic(() => import('@/components/charts').then(m => m.RevenueChart), { ssr: false, loading: chartFallback })
const BarSourceChart = dynamic(() => import('@/components/charts').then(m => m.BarSourceChart), { ssr: false, loading: chartFallback })
const DonutChart = dynamic(() => import('@/components/charts').then(m => m.DonutChart), { ssr: false, loading: chartFallback })
const DailySalesChart = dynamic(() => import('@/components/charts').then(m => m.DailySalesChart), { ssr: false, loading: chartFallback })
const MonthlyRevenueChart = dynamic(() => import('@/components/charts').then(m => m.MonthlyRevenueChart), { ssr: false, loading: chartFallback })
const StatusPieChart = dynamic(() => import('@/components/charts').then(m => m.StatusPieChart), { ssr: false, loading: chartFallback })

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
}
const fadeUp = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] } },
}

export default function DashboardPage() {
  const { businessId } = useBusiness()
  if (businessId === 'ALMA_TRADING') return <TradingDashboard />
  if (businessId === 'CREATIVE_DIGITAL_IT') {
    return <Skeleton className="m-4 h-40 md:m-8" />
  }
  return <LifestyleDashboard />
}

function LifestyleDashboard() {
  const { orders: allOrders, loading, error, enabled } = useOrdersData()
  const { range, label: rangeLabel } = useDateRange()

  const metrics = useMemo(() => {
    const inRange = allOrders.filter(o => {
      const d = o.date?.slice(0, 10)
      return d && d >= range.start && d <= range.end
    })
    return aggregateDashboardMetrics(inRange)
  }, [allOrders, range])

  if (!enabled) {
    return (
      <>
        <PageHeader title="Dashboard" subtitle="Alma Lifestyle orders" actions={<ConnectionStatus />} />
        <div className="p-4 md:p-8">
          <Empty
            icon="◫"
            title="Lifestyle dashboard only"
            desc="Switch to Alma Lifestyle in the business menu to load orders KPIs."
          />
        </div>
      </>
    )
  }

  const kpis = metrics.kpis
  const byStatus = metrics.by_status
  const bySource = metrics.by_source
  const byCategory = metrics.by_category
  const slaBreaches = metrics.sla_breaches
  const recentOrders = metrics.recent_orders
  const hasOrders = metrics.kpis.total_orders > 0

  const sourceArr = Object.entries(bySource).map(([source, v]) => ({ source, ...v }))

  const catPie = Object.entries(byCategory)
    .sort(([, a], [, b]) => b.orders - a.orders)
    .slice(0, 5)
    .map(([name, v], i) => ({
      name,
      value: Math.round(v.orders),
      color: PALETTE[i] ?? '#D4956A',
    }))

  const statusPie = Object.entries(byStatus)
    .filter(([s]) => !['Cancelled', 'CANCELLED'].includes(s))
    .map(([name, value]) => ({ name, value }))

  const topProducts = metrics.top_products.slice(0, 5)

  const profit = kpis.net_business_profit ?? kpis.total_profit

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`${rangeLabel} · Live`}
        actions={<ConnectionStatus />}
      />

      {error && (
        <div className="mx-4 md:mx-8 mt-4 px-4 py-3 bg-red-50 border border-red-200 rounded-2xl flex items-center gap-3">
          <span className="text-red-500 text-sm shrink-0">⚠</span>
          <p className="text-sm text-red-600">{error}</p>
        </div>
      )}

      {slaBreaches.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
          className="mx-4 md:mx-8 mt-4"
        >
          <div className="flex items-center gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-2xl">
            <span className="text-amber-600 text-lg">⚡</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-amber-800">
                {slaBreaches.length} order{slaBreaches.length > 1 ? 's' : ''} need attention
              </p>
              <p className="text-xs text-amber-600 mt-0.5 truncate">
                {slaBreaches.slice(0, 3).map(b => `#${b.id}`).join(', ')}
                {slaBreaches.length > 3 ? ` +${slaBreaches.length - 3} more` : ''}
              </p>
            </div>
            <a href="/orders?status=sla" className="text-xs font-bold text-amber-700 hover:text-amber-900 transition-colors shrink-0">
              View all →
            </a>
          </div>
        </motion.div>
      )}

      <motion.div
        className="p-4 md:p-8 space-y-6"
        variants={stagger}
        initial="hidden"
        animate="show"
      >
        <motion.div variants={fadeUp}>
          <DateRangeFilter />
        </motion.div>

        {/* ── Hero Metrics ──────────────────────────────────── */}
        <motion.div variants={fadeUp} className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
          <HeroKpi
            icon={<IconRevenue />}
            label="Revenue"
            value={loading ? null : fmt(kpis.total_revenue)}
            accent="from-[#E07A5F]/10 to-[#E07A5F]/[0.02]"
            borderColor="border-l-[#E07A5F]"
            loading={loading}
          />
          <HeroKpi
            icon={<IconProfit />}
            label="Net Profit"
            value={loading ? null : fmt(profit)}
            accent={profit < 0 ? 'from-red-100/50 to-red-50/20' : 'from-emerald-100/50 to-emerald-50/20'}
            borderColor={profit < 0 ? 'border-l-red-400' : 'border-l-emerald-500'}
            valueColor={profit < 0 ? 'text-red-600' : 'text-emerald-600'}
            sub="After return losses"
            loading={loading}
          />
          <HeroKpi
            icon={<IconOrders />}
            label="Total Orders"
            value={loading ? null : fmtNum(kpis.total_orders)}
            accent="from-blue-100/50 to-blue-50/20"
            borderColor="border-l-blue-500"
            valueColor="text-blue-700"
            loading={loading}
          />
          <HeroKpi
            icon={<IconDelivered />}
            label="Delivered"
            value={loading ? null : fmtNum(kpis.delivered_count)}
            accent="from-violet-100/50 to-violet-50/20"
            borderColor="border-l-violet-500"
            valueColor="text-violet-700"
            sub={pct(kpis.delivery_rate) + ' delivery rate'}
            loading={loading}
          />
        </motion.div>

        {/* ── Return & Operations Strip ─────────────────────── */}
        <motion.div variants={fadeUp}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <CompactKpi
              label="Return Loss"
              value={loading ? '—' : fmt(kpis.total_returns_loss ?? 0)}
              color="text-red-600"
              sub={`${kpis.returned_paid_count ?? 0} paid · ${kpis.returned_unpaid_count ?? 0} refused`}
            />
            <CompactKpi
              label="Return Rate"
              value={loading ? '—' : pct(kpis.return_rate)}
              color={kpis.return_rate > 20 ? 'text-red-600' : kpis.return_rate > 10 ? 'text-amber-600' : 'text-slate-600'}
              sub={`Paid ${kpis.return_rate_paid ?? 0}% · Refused ${kpis.return_rate_refused ?? 0}%`}
            />
            <CompactKpi
              label="Pending"
              value={loading ? '—' : fmtNum(kpis.pending_count)}
              color="text-amber-600"
              sub="Awaiting action"
            />
            <CompactKpi
              label="Realized Profit"
              value={loading ? '—' : fmt(kpis.total_realized_profit ?? kpis.total_profit)}
              color="text-emerald-600"
              sub="Delivered orders only"
            />
          </div>
        </motion.div>

        {/* ── Charts: Daily + Monthly ──────────────────────── */}
        <motion.div variants={fadeUp} className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ChartCard title="Daily Sales" subtitle={rangeLabel}>
            {loading ? (
              <Skeleton className="h-48 w-full rounded-xl" />
            ) : !hasOrders || metrics.daily_trend.length === 0 ? (
              <Empty icon="◈" title="No data" desc="Pick another date range" />
            ) : (
              <DailySalesChart data={metrics.daily_trend} />
            )}
          </ChartCard>

          <ChartCard
            title="Monthly Revenue"
            subtitle={rangeLabel}
            legend={[
              { color: 'bg-[#E07A5F]', label: 'Revenue' },
              { color: 'bg-emerald-500', label: 'Profit' },
            ]}
          >
            {loading ? (
              <Skeleton className="h-48 w-full rounded-xl" />
            ) : !hasOrders || metrics.monthly_trend.length === 0 ? (
              <Empty icon="◈" title="No data" desc="Monthly breakdown appears when orders exist" />
            ) : (
              <MonthlyRevenueChart data={metrics.monthly_trend} />
            )}
          </ChartCard>
        </motion.div>

        {/* ── Charts: Trend + Status Pie ────────────────────── */}
        <motion.div variants={fadeUp} className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <ChartCard
            title="Revenue & Profit Trend"
            subtitle={rangeLabel}
            className="lg:col-span-2"
            legend={[
              { color: 'bg-[#E07A5F]', label: 'Revenue' },
              { color: 'bg-emerald-500', label: 'Profit' },
            ]}
          >
            {loading ? (
              <Skeleton className="h-48 w-full rounded-xl" />
            ) : metrics.monthly_trend.length === 0 ? (
              <Empty icon="◈" title="No data" desc="Revenue chart appears once orders exist" />
            ) : (
              <RevenueChart data={metrics.monthly_trend} />
            )}
          </ChartCard>

          <ChartCard title="Order Status">
            {loading ? (
              <Skeleton className="h-48 w-full rounded-xl" />
            ) : statusPie.length === 0 ? (
              <Empty icon="◫" title="No data" desc="Status breakdown updates with your filter" />
            ) : (
              <div>
                <StatusPieChart data={statusPie} />
                <div className="grid grid-cols-2 gap-1.5 mt-3">
                  {statusPie.map(s => (
                    <div key={s.name} className="bg-slate-50 rounded-xl px-3 py-2 text-center">
                      <p className="text-sm font-bold text-slate-800">{s.value}</p>
                      <p className="text-[10px] text-slate-500">{s.name}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </ChartCard>
        </motion.div>

        {/* ── Charts: Category + Channel ────────────────────── */}
        <motion.div variants={fadeUp} className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ChartCard title="Category Mix">
            {loading ? (
              <Skeleton className="h-40 w-full rounded-xl" />
            ) : catPie.length === 0 ? (
              <Empty icon="◧" title="No data" desc="Category mix appears once orders exist" />
            ) : (
              <div>
                <DonutChart data={catPie} />
                <div className="space-y-2 mt-4">
                  {catPie.map(c => (
                    <div key={c.name} className="flex items-center gap-3">
                      <span className="w-2.5 h-2.5 rounded-md shrink-0" style={{ background: c.color }} />
                      <span className="text-xs text-slate-600 flex-1">{c.name}</span>
                      <span className="text-xs font-bold text-slate-800 tabular-nums">{c.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </ChartCard>

          <ChartCard title="Orders by Channel">
            {sourceArr.length === 0 && !loading ? (
              <Empty icon="◩" title="No data" desc="Channel breakdown updates with your filter" />
            ) : loading ? (
              <Skeleton className="h-40 w-full rounded-xl" />
            ) : (
              <BarSourceChart data={sourceArr} />
            )}
          </ChartCard>
        </motion.div>

        {/* ── Top Products ──────────────────────────────────── */}
        <motion.div variants={fadeUp}>
          <Card className="overflow-hidden">
            <div className="px-5 py-4 border-b border-black/[0.06] flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-800">Top Products</h3>
                <p className="text-[10px] text-slate-500 mt-0.5">{rangeLabel}</p>
              </div>
            </div>
            <div className="divide-y divide-black/[0.04]">
              {loading ? (
                Array(4).fill(0).map((_, i) => (
                  <div key={i} className="px-5 py-4"><Skeleton className="h-3 w-full" /></div>
                ))
              ) : topProducts.length === 0 ? (
                <div className="px-5 py-10">
                  <Empty icon="◧" title="No products" desc="Top sellers appear when orders exist" />
                </div>
              ) : (
                topProducts.map((p, i) => (
                  <div key={p.product} className="px-5 py-3.5 flex items-center gap-4 hover:bg-slate-50/80 transition-colors">
                    <span className="w-7 h-7 rounded-lg bg-[#E07A5F]/10 text-[#E07A5F] text-xs font-bold flex items-center justify-center shrink-0">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-slate-800 truncate">{p.product}</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">
                        {p.orders} orders
                        {p.pieces > 0 ? ` · ${fmtNum(p.pieces)} pcs` : ''}
                      </p>
                      {p.group_details.length > 0 ? (
                        <p className="text-[10px] text-emerald-600 mt-0.5 leading-relaxed">
                          {p.group_details.slice(0, 2).map(formatGroupSizeLine).join(' | ')}
                        </p>
                      ) : p.top_size ? (
                        <p className="text-[10px] text-emerald-600 mt-0.5 truncate">
                          Top: {p.top_size.label} · {fmtNum(p.top_size.pieces)} pcs
                        </p>
                      ) : null}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-bold text-[#E07A5F] tabular-nums"><Money amount={p.revenue} /></p>
                      <p className="text-[10px] font-semibold text-emerald-600 tabular-nums mt-0.5"><Money amount={p.profit} /></p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>
        </motion.div>

        {/* ── Recent Orders ─────────────────────────────────── */}
        <motion.div variants={fadeUp}>
          <Card className="overflow-hidden">
            <div className="px-5 py-4 border-b border-black/[0.06] flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-800">Recent Orders</h3>
              <a href="/orders" className="text-xs font-semibold text-[#E07A5F] hover:text-[#C45A3C] transition-colors">
                View all →
              </a>
            </div>
            <div className="divide-y divide-black/[0.04]">
              {loading
                ? Array(5).fill(0).map((_, i) => (
                    <div key={i} className="px-5 py-4 flex items-center gap-3">
                      <Skeleton className="w-16 h-3" />
                      <Skeleton className="flex-1 h-3" />
                      <Skeleton className="w-20 h-5 rounded-full" />
                      <Skeleton className="w-16 h-3" />
                    </div>
                  ))
                : recentOrders.length === 0
                  ? <div className="px-5 py-10"><Empty icon="◫" title="No orders" desc="Recent orders appear for the selected date range" /></div>
                  : (recentOrders as Partial<Order>[]).slice(0, 6).map(o => (
                      <div key={o.id} className="px-5 py-3.5 flex items-center gap-3 hover:bg-slate-50/80 transition-colors">
                        <span className="font-mono text-[11px] text-[#E07A5F] font-bold shrink-0 w-16">{o.id}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-slate-800 truncate">{o.customer}</p>
                          <p className="text-[10px] text-slate-500 truncate">{o.product}</p>
                        </div>
                        {o.status && <StatusBadge status={o.status} />}
                        <span className="text-xs font-bold text-slate-800 tabular-nums shrink-0"><Money amount={o.sell_price ?? 0} /></span>
                      </div>
                    ))
              }
            </div>
          </Card>
        </motion.div>

        {/* ── SLA Breach Detail ─────────────────────────────── */}
        {slaBreaches.length > 0 && (
          <motion.div variants={fadeUp}>
            <Card className="overflow-hidden border-amber-200">
              <div className="px-5 py-3.5 flex items-center gap-3 border-b border-amber-200 bg-amber-50">
                <span className="text-amber-600 text-lg">⚡</span>
                <h3 className="text-sm font-bold text-amber-800">
                  SLA Alerts — {slaBreaches.length} order{slaBreaches.length > 1 ? 's' : ''}
                </h3>
              </div>
              <div className="divide-y divide-amber-100">
                {slaBreaches.map((b, i) => (
                  <div key={i} className="px-5 py-3 flex items-center gap-3 hover:bg-amber-50/50 transition-colors">
                    <span className="font-mono text-[11px] text-[#E07A5F] font-bold w-16 shrink-0">{b.id}</span>
                    <span className="text-xs text-slate-700 flex-1">{b.customer}</span>
                    <span className="text-[10px] text-amber-700 font-semibold bg-amber-100 px-2.5 py-1 rounded-full">{b.sla_status}</span>
                  </div>
                ))}
              </div>
            </Card>
          </motion.div>
        )}

      </motion.div>
    </>
  )
}

/* ── Sub-components ───────────────────────────────────────────────── */

function HeroKpi({ icon, label, value, accent, borderColor, valueColor, sub, loading }: {
  icon: React.ReactNode
  label: string
  value: string | null
  accent: string
  borderColor: string
  valueColor?: string
  sub?: string
  loading?: boolean
}) {
  return (
    <div className={`relative overflow-hidden rounded-2xl border border-black/[0.06] bg-white shadow-sm ${borderColor} border-l-[3px]`}>
      <div className={`absolute inset-0 bg-gradient-to-br ${accent} pointer-events-none`} />
      <div className="relative p-4 md:p-5">
        {loading ? (
          <>
            <Skeleton className="h-3 w-16 mb-3" />
            <Skeleton className="h-7 w-24 mb-1" />
            <Skeleton className="h-3 w-20" />
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-slate-400">{icon}</span>
              <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-500">{label}</p>
            </div>
            {value && (
              typeof value === 'string' && value.includes('৳') ? (
                <BdtText
                  value={value}
                  className={`block text-lg md:text-xl font-bold tracking-tight ${valueColor ?? 'text-slate-800'}`}
                />
              ) : (
                <p className={`text-lg md:text-xl font-bold tracking-tight ${valueColor ?? 'text-slate-800'}`}>
                  {value}
                </p>
              )
            )}
            {sub && <p className="text-[10px] text-slate-500 mt-1">{sub}</p>}
          </>
        )}
      </div>
    </div>
  )
}

function CompactKpi({ label, value, color, sub }: {
  label: string; value: string; color: string; sub: string
}) {
  return (
    <div className="bg-white rounded-xl border border-black/[0.04] p-3.5 hover:shadow-sm transition-shadow">
      <p className="text-[10px] font-bold uppercase tracking-[0.06em] text-slate-500 mb-1">{label}</p>
      {typeof value === 'string' && value.includes('৳') ? (
        <BdtText
          value={value}
          className={`block text-sm font-bold tabular-nums ${color}`}
        />
      ) : (
        <p className={`text-sm font-bold tabular-nums ${color}`}>{value}</p>
      )}
      <p className="text-[10px] text-slate-400 mt-0.5">{sub}</p>
    </div>
  )
}

function ChartCard({ title, subtitle, legend, className, children }: {
  title: string
  subtitle?: string
  legend?: Array<{ color: string; label: string }>
  className?: string
  children: React.ReactNode
}) {
  return (
    <Card className={`p-5 ${className ?? ''}`}>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-sm font-bold text-slate-800">{title}</h3>
          {subtitle && <p className="text-[10px] text-slate-500 mt-0.5">{subtitle}</p>}
        </div>
        {legend && (
          <div className="flex gap-3">
            {legend.map(l => (
              <div key={l.label} className="flex items-center gap-1.5">
                <div className={`w-2 h-2 rounded-full ${l.color}`} />
                <span className="text-[10px] text-slate-500">{l.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {children}
    </Card>
  )
}

function IconRevenue() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1v14M11.5 3.5H6.25a2.25 2.25 0 000 4.5h3.5a2.25 2.25 0 010 4.5H4" />
    </svg>
  )
}

function IconProfit() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12l4-4 3 3 5-7" />
    </svg>
  )
}

function IconOrders() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M5.5 6h5M5.5 8.5h3" />
    </svg>
  )
}

function IconDelivered() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  )
}
