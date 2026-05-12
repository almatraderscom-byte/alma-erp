'use client'
import { motion } from 'framer-motion'
import { useDashboard } from '@/hooks/useERP'
import { Card, KpiCard, GoldDivider, Skeleton, StatusBadge, PageHeader } from '@/components/ui'
import { ConnectionStatus } from '@/components/ui/ConnectionStatus'
import { RevenueChart, BarSourceChart, DonutChart } from '@/components/charts'
import { fmt, fmtNum, pct } from '@/lib/utils'
import { REVENUE_TREND, MOCK_DASHBOARD } from '@/lib/data'
import { IS_LIVE } from '@/lib/api'
import type { Order } from '@/types'

const CATEGORY_PIE = [
  { name:'Punjabi', value:38, color:'#C9A84C' },
  { name:'Kurti',   value:24, color:'#8B6914' },
  { name:'Dress',   value:18, color:'#E8C96A' },
  { name:'Saree',   value:12, color:'#6B5530' },
  { name:'Acc.',    value: 8, color:'#4A3A20' },
]

const fade = (i: number) => ({
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  transition: { delay: i * 0.07, duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] },
})

export default function DashboardPage() {
  const { data, loading, error } = useDashboard()
  const d = data ?? MOCK_DASHBOARD
  const kpis = d.kpis
  const sourceArr = Object.entries(d.by_source).map(([source, v]) => ({ source, ...v }))

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={IS_LIVE ? 'Google Sheets · Live' : 'Mock data — configure NEXT_PUBLIC_API_URL to go live'}
        actions={<ConnectionStatus />}
      />

      {/* API error banner */}
      {error && (
        <div className="mx-4 md:mx-8 mt-4 px-4 py-3 bg-red-400/10 border border-red-400/25 rounded-xl flex items-center gap-3">
          <span className="text-red-400 text-sm shrink-0">⚠</span>
          <p className="text-sm text-red-300">{error}</p>
          <span className="text-[11px] text-red-500 ml-auto">Showing last cached data</span>
        </div>
      )}

      <div className="p-4 md:p-8 space-y-5">

        {/* Primary KPIs */}
        <motion.div {...fade(0)} className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="Total Revenue" value={loading ? '—' : fmt(kpis.total_revenue)} sub="All confirmed orders" color="text-gold-lt" delta={18} loading={loading} />
          <KpiCard label="Net Profit"    value={loading ? '—' : fmt(kpis.total_profit)}  sub="After all costs"      color="text-green-400" delta={12} loading={loading} />
          <KpiCard label="Total Orders"  value={loading ? '—' : fmtNum(kpis.total_orders)} sub="Placed this period" loading={loading} />
          <KpiCard label="Delivery Rate" value={loading ? '—' : pct(kpis.delivery_rate)}   sub="Of all orders" color="text-blue-400" delta={5} loading={loading} />
        </motion.div>

        {/* Secondary KPIs */}
        <motion.div {...fade(1)} className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="Avg Order"    value={loading ? '—' : fmt(kpis.avg_order_value)} sub="Per order" loading={loading} />
          <KpiCard label="Gross Margin" value={loading ? '—' : pct(kpis.gross_margin)}    sub="Revenue margin" color="text-gold" loading={loading} />
          <KpiCard label="Return Rate"  value={loading ? '—' : pct(kpis.return_rate)}    sub="Orders returned" color={kpis.return_rate > 15 ? 'text-red-400' : 'text-cream'} loading={loading} />
          <KpiCard label="SLA Breaches" value={loading ? '—' : kpis.sla_breaches}        sub="Need attention" color={kpis.sla_breaches > 0 ? 'text-amber-400' : 'text-green-400'} loading={loading} />
        </motion.div>

        {/* Charts */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <motion.div {...fade(2)} className="md:col-span-2">
            <Card className="p-5">
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm font-bold text-cream">Revenue & Profit Trend</p>
                <p className="text-[10px] text-zinc-500">5-month window</p>
              </div>
              <RevenueChart data={REVENUE_TREND} />
              <div className="flex gap-5 mt-3">
                {[{ color: 'bg-gold', label: 'Revenue' }, { color: 'bg-green-400', label: 'Profit' }].map(l => (
                  <div key={l.label} className="flex items-center gap-2">
                    <div className={`w-4 h-0.5 ${l.color} rounded`} />
                    <span className="text-[10px] text-zinc-500">{l.label}</span>
                  </div>
                ))}
              </div>
            </Card>
          </motion.div>

          <motion.div {...fade(3)}>
            <Card className="p-5 h-full">
              <p className="text-sm font-bold text-cream mb-4">Category Mix</p>
              <DonutChart data={CATEGORY_PIE} />
              <div className="space-y-2 mt-3">
                {CATEGORY_PIE.map(c => (
                  <div key={c.name} className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: c.color }} />
                    <span className="text-[11px] text-zinc-400 flex-1">{c.name}</span>
                    <span className="text-[11px] font-bold text-cream">{c.value}%</span>
                  </div>
                ))}
              </div>
            </Card>
          </motion.div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <motion.div {...fade(4)}>
            <Card className="p-5">
              <p className="text-sm font-bold text-cream mb-4">Order Status</p>
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(d.by_status).filter(([s]) => s !== 'Cancelled').map(([status, count]) => (
                  <div key={status} className="bg-surface rounded-xl p-3 text-center">
                    <p className="text-xl font-bold text-cream">{count}</p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">{status}</p>
                  </div>
                ))}
              </div>
              <GoldDivider className="my-4" />
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-zinc-500">Delivery success rate</span>
                <span className="font-bold text-green-400">{pct(kpis.delivery_rate)}</span>
              </div>
              <div className="h-1.5 bg-border rounded-full overflow-hidden">
                <motion.div className="h-full bg-green-400 rounded-full" initial={{ width: 0 }} animate={{ width: `${kpis.delivery_rate}%` }} transition={{ duration: 1, ease: 'easeOut' }} />
              </div>
            </Card>
          </motion.div>

          <motion.div {...fade(5)}>
            <Card className="p-5">
              <p className="text-sm font-bold text-cream mb-4">Orders by Channel</p>
              <BarSourceChart data={sourceArr} />
            </Card>
          </motion.div>
        </div>

        {/* Recent Orders */}
        <motion.div {...fade(6)}>
          <Card className="overflow-hidden">
            <div className="px-5 py-4 flex items-center justify-between border-b border-border">
              <p className="text-sm font-bold text-cream">Recent Orders</p>
              <a href="/orders" className="text-[11px] text-gold hover:text-gold-lt transition-colors font-semibold">View all →</a>
            </div>
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
                : (d.recent_orders as Partial<Order>[]).slice(0, 6).map(o => (
                    <div key={o.id} className="px-5 py-3 flex items-center gap-3 hover:bg-white/[0.02] transition-colors">
                      <span className="font-mono text-[11px] text-gold font-bold shrink-0 w-16">{o.id}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-cream truncate">{o.customer}</p>
                        <p className="text-[10px] text-zinc-500 truncate">{o.product}</p>
                      </div>
                      {o.status && <StatusBadge status={o.status} />}
                      <span className="text-xs font-bold text-cream tabular-nums shrink-0">{fmt(o.sell_price ?? 0)}</span>
                    </div>
                  ))
              }
            </div>
          </Card>
        </motion.div>

        {/* SLA Alerts */}
        {d.sla_breaches.length > 0 && (
          <motion.div {...fade(7)}>
            <Card className="overflow-hidden border-amber-400/20">
              <div className="px-5 py-3 flex items-center gap-2.5 border-b border-amber-400/15 bg-amber-400/5">
                <span className="text-amber-400 text-sm">⚡</span>
                <p className="text-sm font-bold text-amber-400">SLA Alerts — {d.sla_breaches.length} order{d.sla_breaches.length > 1 ? 's' : ''} need attention</p>
              </div>
              <div className="divide-y divide-border/50">
                {d.sla_breaches.map((b, i) => (
                  <div key={i} className="px-5 py-3 flex items-center gap-3">
                    <span className="font-mono text-[11px] text-gold font-bold w-16 shrink-0">{b.id}</span>
                    <span className="text-xs text-cream flex-1">{b.customer}</span>
                    <span className="text-[10px] text-amber-400 font-semibold">{b.sla_status}</span>
                  </div>
                ))}
              </div>
            </Card>
          </motion.div>
        )}

      </div>
    </>
  )
}
