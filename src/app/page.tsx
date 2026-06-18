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
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.02 } },
}
const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 260, damping: 26, mass: 0.7 } },
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
        <div className="mx-4 md:mx-8 mt-4 px-4 py-3 bg-danger/10 border border-danger/30 rounded-2xl flex items-center gap-3">
          <span className="text-danger text-sm shrink-0">⚠</span>
          <p className="text-sm text-danger">{error}</p>
        </div>
      )}

      {slaBreaches.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
          className="mx-4 md:mx-8 mt-4"
        >
          <div className="flex items-center gap-3 px-4 py-3 bg-warning/10 border border-warning/30 rounded-2xl">
            <span className="text-warning text-lg">⚡</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-warning">
                {slaBreaches.length} order{slaBreaches.length > 1 ? 's' : ''} need attention
              </p>
              <p className="text-xs text-warning mt-0.5 truncate">
                {slaBreaches.slice(0, 3).map(b => `#${b.id}`).join(', ')}
                {slaBreaches.length > 3 ? ` +${slaBreaches.length - 3} more` : ''}
              </p>
            </div>
            <a href="/orders?status=sla" className="text-xs font-bold text-warning hover:text-warning transition-colors shrink-0">
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
            accent="from-gold/10 to-gold/[0.02]"
            borderColor="border-l-gold"
            loading={loading}
          />
          <HeroKpi
            icon={<IconProfit />}
            label="Net Profit"
            value={loading ? null : fmt(profit)}
            accent={profit < 0 ? 'from-danger/15 to-danger/5' : 'from-success/15 to-success/5'}
            borderColor={profit < 0 ? 'border-l-danger' : 'border-l-success'}
            valueColor={profit < 0 ? 'text-danger' : 'text-success'}
            sub="After return losses"
            loading={loading}
          />
          <HeroKpi
            icon={<IconOrders />}
            label="Total Orders"
            value={loading ? null : fmtNum(kpis.total_orders)}
            accent="from-info/15 to-info/5"
            borderColor="border-l-info"
            valueColor="text-info"
            loading={loading}
          />
          <HeroKpi
            icon={<IconDelivered />}
            label="Delivered"
            value={loading ? null : fmtNum(kpis.delivered_count)}
            accent="from-violet-500/10 to-violet-500/[0.04]"
            borderColor="border-l-violet-500"
            valueColor="text-violet-500"
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
              color="text-danger"
              sub={`${kpis.returned_paid_count ?? 0} paid · ${kpis.returned_unpaid_count ?? 0} refused`}
            />
            <CompactKpi
              label="Return Rate"
              value={loading ? '—' : pct(kpis.return_rate)}
              color={kpis.return_rate > 20 ? 'text-danger' : kpis.return_rate > 10 ? 'text-warning' : 'text-muted-hi'}
              sub={`Paid ${kpis.return_rate_paid ?? 0}% · Refused ${kpis.return_rate_refused ?? 0}%`}
            />
            <CompactKpi
              label="Pending"
              value={loading ? '—' : fmtNum(kpis.pending_count)}
              color="text-warning"
              sub="Awaiting action"
            />
            <CompactKpi
              label="Realized Profit"
              value={loading ? '—' : fmt(kpis.total_realized_profit ?? kpis.total_profit)}
              color="text-success"
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
              { color: 'bg-gold', label: 'Revenue' },
              { color: 'bg-success', label: 'Profit' },
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
              { color: 'bg-gold', label: 'Revenue' },
              { color: 'bg-success', label: 'Profit' },
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
                    <div key={s.name} className="bg-bg-2 rounded-xl px-3 py-2 text-center">
                      <p className="text-sm font-bold text-cream">{s.value}</p>
                      <p className="text-[10px] text-muted">{s.name}</p>
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
                      <span className="text-xs text-muted-hi flex-1">{c.name}</span>
                      <span className="text-xs font-bold text-cream tabular-nums">{c.value}</span>
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
            <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-cream">Top Products</h3>
                <p className="text-[10px] text-muted mt-0.5">{rangeLabel}</p>
              </div>
            </div>
            <div className="divide-y divide-border-subtle">
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
                  <div key={p.product} className="px-5 py-3.5 flex items-center gap-4 hover:bg-bg-2 transition-colors">
                    <span className="w-7 h-7 rounded-lg bg-gold/10 text-gold text-xs font-bold flex items-center justify-center shrink-0">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-cream truncate">{p.product}</p>
                      <p className="text-[10px] text-muted mt-0.5">
                        {p.orders} orders
                        {p.pieces > 0 ? ` · ${fmtNum(p.pieces)} pcs` : ''}
                      </p>
                      {p.group_details.length > 0 ? (
                        <p className="text-[10px] text-success mt-0.5 leading-relaxed">
                          {p.group_details.slice(0, 2).map(formatGroupSizeLine).join(' | ')}
                        </p>
                      ) : p.top_size ? (
                        <p className="text-[10px] text-success mt-0.5 truncate">
                          Top: {p.top_size.label} · {fmtNum(p.top_size.pieces)} pcs
                        </p>
                      ) : null}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-bold text-gold tabular-nums"><Money amount={p.revenue} /></p>
                      <p className="text-[10px] font-semibold text-success tabular-nums mt-0.5"><Money amount={p.profit} /></p>
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
            <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between">
              <h3 className="text-sm font-bold text-cream">Recent Orders</h3>
              <a href="/orders" className="text-xs font-semibold text-gold hover:text-gold-dim transition-colors">
                View all →
              </a>
            </div>
            <div className="divide-y divide-border-subtle">
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
                      <div key={o.id} className="px-5 py-3.5 flex items-center gap-3 hover:bg-bg-2 transition-colors">
                        <span className="font-mono text-[11px] text-gold font-bold shrink-0 w-16">{o.id}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-cream truncate">{o.customer}</p>
                          <p className="text-[10px] text-muted truncate">{o.product}</p>
                        </div>
                        {o.status && <StatusBadge status={o.status} />}
                        <span className="text-xs font-bold text-cream tabular-nums shrink-0"><Money amount={o.sell_price ?? 0} /></span>
                      </div>
                    ))
              }
            </div>
          </Card>
        </motion.div>

        {/* ── SLA Breach Detail ─────────────────────────────── */}
        {slaBreaches.length > 0 && (
          <motion.div variants={fadeUp}>
            <Card className="overflow-hidden border-warning/30">
              <div className="px-5 py-3.5 flex items-center gap-3 border-b border-warning/30 bg-warning/10">
                <span className="text-warning text-lg">⚡</span>
                <h3 className="text-sm font-bold text-warning">
                  SLA Alerts — {slaBreaches.length} order{slaBreaches.length > 1 ? 's' : ''}
                </h3>
              </div>
              <div className="divide-y divide-warning/20">
                {slaBreaches.map((b, i) => (
                  <div key={i} className="px-5 py-3 flex items-center gap-3 hover:bg-warning/10 transition-colors">
                    <span className="font-mono text-[11px] text-gold font-bold w-16 shrink-0">{b.id}</span>
                    <span className="text-xs text-muted-hi flex-1">{b.customer}</span>
                    <span className="text-[10px] text-warning font-semibold bg-warning/20 px-2.5 py-1 rounded-full">{b.sla_status}</span>
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
    <motion.div
      whileHover={{ y: -3 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      className={`relative overflow-hidden rounded-2xl border border-border-subtle bg-card/80 shadow-card will-change-transform ${borderColor} border-l-[3px]`}
    >
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
              <span className="text-muted">{icon}</span>
              <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted">{label}</p>
            </div>
            {value && (
              typeof value === 'string' && value.includes('৳') ? (
                <BdtText
                  value={value}
                  className={`block text-lg md:text-xl font-bold tracking-tight ${valueColor ?? 'text-cream'}`}
                />
              ) : (
                <p className={`text-lg md:text-xl font-bold tracking-tight ${valueColor ?? 'text-cream'}`}>
                  {value}
                </p>
              )
            )}
            {sub && <p className="text-[10px] text-muted mt-1">{sub}</p>}
          </>
        )}
      </div>
    </motion.div>
  )
}

function CompactKpi({ label, value, color, sub }: {
  label: string; value: string; color: string; sub: string
}) {
  return (
    <motion.div
      whileHover={{ y: -2 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      className="bg-card/80 rounded-xl border border-border-subtle p-3.5 shadow-card will-change-transform">
      <p className="text-[10px] font-bold uppercase tracking-[0.06em] text-muted mb-1">{label}</p>
      {typeof value === 'string' && value.includes('৳') ? (
        <BdtText
          value={value}
          className={`block text-sm font-bold tabular-nums ${color}`}
        />
      ) : (
        <p className={`text-sm font-bold tabular-nums ${color}`}>{value}</p>
      )}
      <p className="text-[10px] text-muted mt-0.5">{sub}</p>
    </motion.div>
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
          <h3 className="text-sm font-bold text-cream">{title}</h3>
          {subtitle && <p className="text-[10px] text-muted mt-0.5">{subtitle}</p>}
        </div>
        {legend && (
          <div className="flex gap-3">
            {legend.map(l => (
              <div key={l.label} className="flex items-center gap-1.5">
                <div className={`w-2 h-2 rounded-full ${l.color}`} />
                <span className="text-[10px] text-muted">{l.label}</span>
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
