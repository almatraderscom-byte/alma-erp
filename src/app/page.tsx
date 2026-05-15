'use client'
import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { useOrdersData } from '@/contexts/OrdersDataContext'
import { useDateRange } from '@/contexts/DateRangeContext'
import { DateRangeFilter } from '@/components/date-filter/DateRangeFilter'
import { aggregateDashboardMetrics } from '@/lib/order-analytics'
import { Card, KpiCard, Skeleton, StatusBadge, PageHeader, Empty, Money, BdtText } from '@/components/ui'
import { ConnectionStatus } from '@/components/ui/ConnectionStatus'
import {
  RevenueChart,
  BarSourceChart,
  DonutChart,
  DailySalesChart,
  MonthlyRevenueChart,
  StatusPieChart,
} from '@/components/charts'
import { fmt, fmtNum, pct } from '@/lib/utils'
import type { Order } from '@/types'

const PALETTE = ['#C9A84C', '#8B6914', '#E8C96A', '#6B5530', '#4A3A20']

const fade = (i: number) => ({
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  transition: { delay: i * 0.07, duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] as const },
})

export default function DashboardPage() {
  const { orders: allOrders, loading, error } = useOrdersData()
  const { range, label: rangeLabel } = useDateRange()

  const metrics = useMemo(() => {
    const inRange = allOrders.filter(o => {
      const d = o.date?.slice(0, 10)
      return d && d >= range.start && d <= range.end
    })
    return aggregateDashboardMetrics(inRange)
  }, [allOrders, range])

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
      color: PALETTE[i] ?? '#3D3020',
    }))

  const statusPie = Object.entries(byStatus)
    .filter(([s]) => s !== 'Cancelled')
    .map(([name, value]) => ({ name, value }))

  const topProducts = metrics.top_products.slice(0, 5)

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`${rangeLabel} · Google Sheets · Live`}
        actions={<ConnectionStatus />}
      />

      {error && (
        <div className="mx-4 md:mx-8 mt-4 px-4 py-3 bg-red-400/10 border border-red-400/25 rounded-xl flex items-center gap-3">
          <span className="text-red-400 text-sm shrink-0">⚠</span>
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      <motion.div layout className="p-4 md:p-8 space-y-5">

        <DateRangeFilter />

        {/* Primary KPIs */}
        <motion.div {...fade(0)} className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="Revenue" value={loading ? '—' : fmt(kpis.total_revenue)} sub={rangeLabel} color="text-gold-lt" loading={loading} />
          <KpiCard label="Net Profit" value={loading ? '—' : fmt(kpis.total_profit)} sub="After all costs" color="text-green-400" loading={loading} />
          <KpiCard label="Orders" value={loading ? '—' : fmtNum(kpis.total_orders)} sub="In period" loading={loading} />
          <KpiCard label="Delivered" value={loading ? '—' : fmtNum(kpis.delivered_count)} sub={pct(kpis.delivery_rate) + ' rate'} color="text-blue-400" loading={loading} />
        </motion.div>

        {/* Secondary KPIs */}
        <motion.div {...fade(1)} className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="Pending" value={loading ? '—' : fmtNum(kpis.pending_count)} sub="Awaiting action" color="text-amber-400" loading={loading} />
          <KpiCard label="Returns" value={loading ? '—' : fmtNum(kpis.returned_count)} sub={pct(kpis.return_rate) + ' rate'} color={kpis.return_rate > 15 ? 'text-red-400' : 'text-cream'} loading={loading} />
          <KpiCard label="COD Amount" value={loading ? '—' : fmt(kpis.cod_amount)} sub="Cash on delivery" loading={loading} />
          <KpiCard label="SLA Breaches" value={loading ? '—' : kpis.sla_breaches} sub="Need attention" color={kpis.sla_breaches > 0 ? 'text-amber-400' : 'text-green-400'} loading={loading} />
        </motion.div>

        {/* Charts row 1: daily + monthly */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <motion.div {...fade(2)}>
            <Card className="p-5">
              <p className="text-sm font-bold text-cream mb-4">Daily Sales</p>
              {loading ? (
                <Skeleton className="h-48 w-full rounded-xl" />
              ) : !hasOrders || metrics.daily_trend.length === 0 ? (
                <Empty icon="◈" title="No orders found for selected period" desc="Pick another date range to see daily sales" />
              ) : (
                <DailySalesChart data={metrics.daily_trend} />
              )}
            </Card>
          </motion.div>

          <motion.div {...fade(3)}>
            <Card className="p-5">
              <p className="text-sm font-bold text-cream mb-4">Monthly Revenue</p>
              {loading ? (
                <Skeleton className="h-48 w-full rounded-xl" />
              ) : !hasOrders || metrics.monthly_trend.length === 0 ? (
                <Empty icon="◈" title="No orders found for selected period" desc="Monthly breakdown appears when orders exist in range" />
              ) : (
                <>
                  <MonthlyRevenueChart data={metrics.monthly_trend} />
                  <motion.div layout className="flex gap-5 mt-3">
                    {[{ color: 'bg-gold', label: 'Revenue' }, { color: 'bg-green-400', label: 'Profit' }].map(l => (
                      <div key={l.label} className="flex items-center gap-2">
                        <div className={`w-4 h-0.5 ${l.color} rounded`} />
                        <span className="text-[10px] text-zinc-500">{l.label}</span>
                      </div>
                    ))}
                  </motion.div>
                </>
              )}
            </Card>
          </motion.div>
        </div>

        {/* Revenue trend + status pie */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <motion.div {...fade(4)} className="md:col-span-2">
            <Card className="p-5">
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm font-bold text-cream">Revenue & Profit Trend</p>
                <p className="text-[10px] text-zinc-500">{rangeLabel}</p>
              </div>
              {loading ? (
                <Skeleton className="h-48 w-full rounded-xl" />
              ) : metrics.monthly_trend.length === 0 ? (
                <Empty icon="◈" title="No orders found for selected period" desc="Revenue chart appears once orders exist in range" />
              ) : (
                <>
                  <RevenueChart data={metrics.monthly_trend} />
                  <div className="flex gap-5 mt-3">
                    {[{ color: 'bg-gold', label: 'Revenue' }, { color: 'bg-green-400', label: 'Profit' }].map(l => (
                      <motion.div layout key={l.label} className="flex items-center gap-2">
                        <motion.div layout className={`w-4 h-0.5 ${l.color} rounded`} />
                        <span className="text-[10px] text-zinc-500">{l.label}</span>
                      </motion.div>
                    ))}
                  </div>
                </>
              )}
            </Card>
          </motion.div>

          <motion.div {...fade(5)}>
            <Card className="p-5 h-full">
              <p className="text-sm font-bold text-cream mb-4">Order Status</p>
              {loading ? (
                <Skeleton className="h-48 w-full rounded-xl" />
              ) : statusPie.length === 0 ? (
                <Empty icon="◫" title="No orders found for selected period" desc="Status breakdown updates with your date filter" />
              ) : (
                <>
                  <StatusPieChart data={statusPie} />
                  <div className="grid grid-cols-2 gap-2 mt-3">
                    {statusPie.map(s => (
                      <div key={s.name} className="bg-surface rounded-lg px-2 py-1.5 text-center">
                        <p className="text-sm font-bold text-cream">{s.value}</p>
                        <p className="text-[9px] text-zinc-500">{s.name}</p>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Card>
          </motion.div>
        </div>

        {/* Category + channel */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <motion.div {...fade(6)}>
            <Card className="p-5">
              <p className="text-sm font-bold text-cream mb-4">Category Mix</p>
              {loading ? (
                <Skeleton className="h-40 w-full rounded-xl" />
              ) : catPie.length === 0 ? (
                <Empty icon="◧" title="No orders found for selected period" desc="Category mix appears once orders exist" />
              ) : (
                <>
                  <DonutChart data={catPie} />
                  <div className="space-y-2 mt-3">
                    {catPie.map(c => (
                      <div key={c.name} className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: c.color }} />
                        <span className="text-[11px] text-zinc-400 flex-1">{c.name}</span>
                        <span className="text-[11px] font-bold text-cream">{c.value}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Card>
          </motion.div>

          <motion.div {...fade(7)}>
            <Card className="p-5">
              <p className="text-sm font-bold text-cream mb-4">Orders by Channel</p>
              {sourceArr.length === 0 && !loading ? (
                <Empty icon="◩" title="No orders found for selected period" desc="Channel breakdown updates with your filter" />
              ) : loading ? (
                <Skeleton className="h-40 w-full rounded-xl" />
              ) : (
                <BarSourceChart data={sourceArr} />
              )}
            </Card>
          </motion.div>
        </div>

        {/* Top products */}
        <motion.div {...fade(8)}>
          <Card className="overflow-hidden">
            <div className="px-5 py-4 border-b border-border">
              <p className="text-sm font-bold text-cream">Top Products</p>
              <p className="text-[10px] text-zinc-500 mt-0.5">{rangeLabel}</p>
            </div>
            <div className="divide-y divide-border">
              {loading ? (
                Array(4).fill(0).map((_, i) => (
                  <div key={i} className="px-5 py-3.5"><Skeleton className="h-3 w-full" /></div>
                ))
              ) : topProducts.length === 0 ? (
                <div className="px-5 py-8">
                  <Empty icon="◧" title="No orders found for selected period" desc="Top sellers appear when orders exist in range" />
                </div>
              ) : (
                topProducts.map((p, i) => (
                  <div key={p.product} className="px-5 py-3 flex items-center gap-3 hover:bg-white/[0.02] transition-colors">
                    <span className="text-[11px] font-bold text-gold w-5">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-cream truncate">{p.product}</p>
                      <p className="text-[10px] text-zinc-500">{p.orders} orders</p>
                    </div>
                    <span className="text-xs font-bold text-gold tabular-nums"><Money amount={p.revenue} /></span>
                    <span className="text-xs font-bold text-green-400 tabular-nums"><Money amount={p.profit} /></span>
                  </div>
                ))
              )}
            </div>
          </Card>
        </motion.div>

        {/* Recent Orders */}
        <motion.div {...fade(9)}>
          <Card className="overflow-hidden">
            <motion.div layout className="px-5 py-4 flex items-center justify-between border-b border-border">
              <p className="text-sm font-bold text-cream">Recent Orders</p>
              <a href="/orders" className="text-[11px] text-gold hover:text-gold-lt transition-colors font-semibold">View all →</a>
            </motion.div>
            <div className="divide-y divide-border">
              {loading
                ? Array(5).fill(0).map((_, i) => (
                    <div key={i} className="px-5 py-3.5 flex items-center gap-3">
                      <Skeleton className="w-16 h-3" />
                      <Skeleton className="flex-1 h-3" />
                      <Skeleton className="w-20 h-5 rounded-full" />
                      <Skeleton className="w-16 h-3" />
                    </div>
                  ))
                : recentOrders.length === 0
                  ? <div className="px-5 py-8"><Empty icon="◫" title="No orders found for selected period" desc="Recent orders appear for the selected date range" /></div>
                  : (recentOrders as Partial<Order>[]).slice(0, 6).map(o => (
                      <div key={o.id} className="px-5 py-3 flex items-center gap-3 hover:bg-white/[0.02] transition-colors">
                        <span className="font-mono text-[11px] text-gold font-bold shrink-0 w-16">{o.id}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-cream truncate">{o.customer}</p>
                          <p className="text-[10px] text-zinc-500 truncate">{o.product}</p>
                        </div>
                        {o.status && <StatusBadge status={o.status} />}
                        <span className="text-xs font-bold text-cream tabular-nums shrink-0"><Money amount={o.sell_price ?? 0} /></span>
                      </div>
                    ))
              }
            </div>
          </Card>
        </motion.div>

        {/* SLA Alerts */}
        {slaBreaches.length > 0 && (
          <motion.div {...fade(10)}>
            <Card className="overflow-hidden border-amber-400/20">
              <div className="px-5 py-3 flex items-center gap-2.5 border-b border-amber-400/15 bg-amber-400/5">
                <span className="text-amber-400 text-sm">⚡</span>
                <p className="text-sm font-bold text-amber-400">
                  SLA Alerts — {slaBreaches.length} order{slaBreaches.length > 1 ? 's' : ''} need attention
                </p>
              </div>
              <div className="divide-y divide-border/50">
                {slaBreaches.map((b, i) => (
                  <motion.div layout key={i} className="px-5 py-3 flex items-center gap-3">
                    <span className="font-mono text-[11px] text-gold font-bold w-16 shrink-0">{b.id}</span>
                    <span className="text-xs text-cream flex-1">{b.customer}</span>
                    <span className="text-[10px] text-amber-400 font-semibold">{b.sla_status}</span>
                  </motion.div>
                ))}
              </div>
            </Card>
          </motion.div>
        )}

      </motion.div>
    </>
  )
}
