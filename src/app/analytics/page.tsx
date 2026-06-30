'use client'
import { useMemo } from 'react'
import { motion } from 'framer-motion'
import dynamic from 'next/dynamic'
import { useAnalyticsMerged } from '@/hooks/useERP'
import { useOrdersData } from '@/contexts/OrdersDataContext'
import { useDateRange } from '@/contexts/DateRangeContext'
import { DateRangeFilter } from '@/components/date-filter/DateRangeFilter'
import {
  aggregateDashboardMetrics,
  buildReturnLossTrend,
  buildReturnsByTypePie,
  filterOrdersByDateRange,
} from '@/lib/order-analytics'
import { PageHeader, Card, KpiCard, GoldDivider, Skeleton, Empty , Money, BdtText} from '@/components/ui'
import { formatBDTk } from '@/lib/currency'
import { fmt, fmtNum, pct } from '@/lib/utils'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } }
const fadeUp = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.25 } } }

const chartFallback = () => <Skeleton className="h-48 w-full rounded-xl" />
const RevenueChart = dynamic(() => import('@/components/charts').then(m => m.RevenueChart), { ssr: false, loading: chartFallback })
const ExpenseBarChart = dynamic(() => import('@/components/charts').then(m => m.ExpenseBarChart), { ssr: false, loading: chartFallback })
const DonutChart = dynamic(() => import('@/components/charts').then(m => m.DonutChart), { ssr: false, loading: chartFallback })
const ReturnLossTrendChart = dynamic(() => import('@/components/charts').then(m => m.ReturnLossTrendChart), { ssr: false, loading: chartFallback })

const PALETTE = ['#E07A5F','#C45A3C','#F4A28C','#D4956A','#8B5E3C','#A0644A']

function paymentPie(byPayment: Record<string, number>) {
  const total = Object.values(byPayment).reduce((a, v) => a + v, 0)
  if (total === 0) return []
  const COLORS: Record<string, string> = {
    COD: '#F5A623', bKash: '#E8357A', Nagad: '#F46223',
    Rocket: '#8B5CF6', 'Bank Transfer': '#4A9EFF', Card: '#2ECC71',
  }
  return Object.entries(byPayment).map(([name, count]) => ({
    name,
    value: Math.round(count / total * 100),
    color: COLORS[name] ?? '#9CA3AF',
  }))
}

function expenseBar(byCat: Record<string, number>) {
  const colors = ['#E07A5F','#C45A3C','#F4A28C','#D4956A','#8B5E3C','#A0644A','#7A4530','#5C3320']
  return Object.entries(byCat)
    .sort(([, a], [, b]) => b - a)
    .map(([category, amount], i) => ({ category, amount, color: colors[i] ?? '#888' }))
}

export default function AnalyticsPage() {
  const { data, loading: apiLoading } = useAnalyticsMerged()
  const { orders: allOrders, loading: ordersLoading, enabled } = useOrdersData()
  const { range } = useDateRange()
  const loading = apiLoading || ordersLoading

  const orderMetrics = useMemo(() => {
    if (!enabled) return null
    const inRange = filterOrdersByDateRange(allOrders, range)
    return aggregateDashboardMetrics(inRange)
  }, [allOrders, range, enabled])

  const returnLossTrend = useMemo(
    () => (orderMetrics ? buildReturnLossTrend(filterOrdersByDateRange(allOrders, range)) : []),
    [allOrders, range, orderMetrics, enabled],
  )
  const returnsPie = useMemo(
    () => (enabled ? buildReturnsByTypePie(filterOrdersByDateRange(allOrders, range)) : []),
    [allOrders, range, enabled],
  )

  const returnKpis = orderMetrics?.kpis
  const kpis         = data?.kpis        ?? { total_revenue:0, total_profit:0, gross_margin:0, avg_order_value:0, total_orders:0, delivery_rate:0, return_rate:0, sla_breaches:0, pending_action:0, delivered_count:0, total_cogs:0 }
  const byCategory   = data?.by_category ?? {}
  const bySource     = data?.by_source   ?? {}
  const byPayment    = data?.by_payment  ?? {}

  const catArr = Object.entries(byCategory)
    .map(([name, v]) => ({ name, ...v, margin: v.revenue > 0 ? Math.round(v.profit / v.revenue * 100) : 0 }))
    .sort((a, b) => b.revenue - a.revenue)

  const monthlyTrend = data?.monthly_trend ?? []
  const expenseByCat = data?.expense_by_cat ?? {}
  const totalExpenses = Number(data?.total_expenses ?? 0)

  const payPie  = paymentPie(byPayment)
  const expBars = expenseBar(expenseByCat)

  const isEmpty = !loading && kpis.total_orders === 0

  return (
    <div className="min-h-[100dvh] bg-transparent">
      <PageHeader title="Analytics" subtitle="Revenue · expenses · payroll context — synced to filters" />

      <motion.div variants={stagger} initial="hidden" animate="show" className="min-w-0 max-w-full space-y-6 px-3 py-4 pb-24 sm:px-6 md:pb-6">
        <motion.div variants={fadeUp}>
          <DateRangeFilter />
        </motion.div>

        <motion.div variants={fadeUp} className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="Total Revenue"   value={loading ? '—' : fmt(kpis.total_revenue)}   color="text-gold-lt"   loading={loading} />
          <KpiCard
            label="Net Profit (MTD)"
            value={loading ? '—' : fmt(returnKpis?.net_business_profit ?? kpis.total_profit)}
            color={(returnKpis?.net_business_profit ?? kpis.total_profit) < 0 ? 'text-red-400' : 'text-green-400'}
            loading={loading}
          />
          <KpiCard label="Gross Margin"    value={loading ? '—' : pct(kpis.gross_margin)}    color="text-gold"      loading={loading} />
          <KpiCard label="Avg Order Value" value={loading ? '—' : fmt(kpis.avg_order_value)} loading={loading} />
        </motion.div>

        {returnKpis && (
          <motion.div variants={fadeUp} className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <KpiCard label="Return Loss" value={loading ? '—' : fmt(returnKpis.total_returns_loss ?? 0)} color="txt-neg" loading={loading} />
            <KpiCard label="Return Rate" value={loading ? '—' : pct(returnKpis.return_rate)} sub={`${returnKpis.return_rate_paid ?? 0}% paid · ${returnKpis.return_rate_refused ?? 0}% refused`} loading={loading} />
            <KpiCard label="Refused Returns" value={loading ? '—' : fmtNum(returnKpis.returned_unpaid_count ?? 0)} color="txt-neg" loading={loading} />
          </motion.div>
        )}

        {enabled && (
          <motion.div variants={fadeUp} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="rounded-2xl border border-white/[0.06] p-5 shadow-sm">
              <p className="text-sm font-bold text-cream mb-1">Returns by Type</p>
              <p className="text-[10px] text-muted mb-4">Delivered vs paid vs refused</p>
              {loading ? (
                <Skeleton className="h-48 w-full rounded-xl" />
              ) : returnsPie.length === 0 ? (
                <Empty icon="◫" title="No returns in period" desc="Pie chart appears when return orders exist" />
              ) : (
                <>
                  <DonutChart data={returnsPie} />
                  <div className="space-y-2 mt-3">
                    {returnsPie.map(c => (
                      <div key={c.name} className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: c.color }} />
                        <span className="text-[11px] text-muted flex-1">{c.name}</span>
                        <span className="text-[11px] font-bold text-cream">{c.value}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Card>
            <Card className="rounded-2xl border border-white/[0.06] p-5 shadow-sm">
              <p className="text-sm font-bold text-cream mb-1">Return Loss Trend</p>
              <p className="text-[10px] text-muted mb-4">Daily courier loss from returns</p>
              {loading ? (
                <Skeleton className="h-48 w-full rounded-xl" />
              ) : returnLossTrend.length === 0 ? (
                <Empty icon="◈" title="No return loss yet" desc="Trend builds as returns are recorded" />
              ) : (
                <ReturnLossTrendChart data={returnLossTrend} />
              )}
            </Card>
          </motion.div>
        )}

        <motion.div variants={fadeUp} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="rounded-2xl border border-white/[0.06] p-5 shadow-sm">
            <p className="text-sm font-bold text-cream mb-1">Revenue vs Profit Trend</p>
            <p className="text-[10px] text-muted mb-4">Monthly · live data</p>
            {loading ? (
              <Skeleton className="h-48 w-full rounded-xl" />
            ) : monthlyTrend.length === 0 ? (
              <Empty icon="◈" title="No trend data yet" desc="Revenue chart appears after orders are placed" />
            ) : (
              <RevenueChart data={monthlyTrend} />
            )}
          </Card>

          <Card className="rounded-2xl border border-white/[0.06] p-5 shadow-sm">
            <p className="text-sm font-bold text-cream mb-1">Expense Breakdown</p>
            <p className="text-[10px] text-muted mb-4">
              {totalExpenses > 0 ? <><BdtText value={formatBDTk(totalExpenses)} /> total · live data</> : 'No expense data yet'}
            </p>
            {loading ? (
              <Skeleton className="h-48 w-full rounded-xl" />
            ) : expBars.length === 0 ? (
              <Empty icon="◫" title="No expenses recorded" desc="Appears after expenses are logged" />
            ) : (
              <ExpenseBarChart data={expBars} />
            )}
          </Card>
        </motion.div>

        <motion.div variants={fadeUp}>
          <Card className="rounded-2xl border border-white/[0.06] overflow-hidden shadow-sm">
            <div className="px-5 py-4 border-b border-white/[0.06]">
              <p className="text-sm font-bold text-cream">Category Performance</p>
            </div>
            {loading ? (
              <div className="p-5 space-y-3">
                {Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-8 w-full rounded-lg" />)}
              </div>
            ) : catArr.length === 0 ? (
              <div className="p-5"><Empty icon="◧" title="No category data" desc="Appears once orders are placed" /></div>
            ) : (
              <div className="overflow-x-auto min-w-0 max-w-full table-scroll">
                <table className="w-full min-w-[720px] text-xs border-collapse">
                  <thead className="sticky top-0 z-[1] bg-card/90 backdrop-blur-sm">
                    <tr className="border-b border-white/[0.06]">
                      {['Category','Orders','Revenue','Profit','Margin'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-[10px] font-semibold tracking-[0.08em] uppercase text-muted">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {catArr.map((c, i) => (
                      <tr key={c.name} className="border-b border-white/[0.04] hover:bg-white/[0.04] transition-colors">
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-2.5">
                            <div className="w-2 h-2 rounded-sm" style={{ background: PALETTE[i] ?? '#3D3020' }} />
                            <span className="font-semibold text-cream">{c.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 text-muted">{c.orders}</td>
                        <td className="px-4 py-3.5 font-bold text-cream tabular-nums"><Money amount={c.revenue} /></td>
                        <td className="px-4 py-3.5 font-bold text-green-600 tabular-nums"><Money amount={c.profit} /></td>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1 bg-white/[0.06] rounded-full overflow-hidden w-16">
                              <div className="h-full bg-gold rounded-full" style={{ width: `${c.margin}%` }} />
                            </div>
                            <span className="text-[11px] font-bold text-gold w-8 text-right">{c.margin}%</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </motion.div>

        <motion.div variants={fadeUp} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="rounded-2xl border border-white/[0.06] p-5 shadow-sm">
            <p className="text-sm font-bold text-cream mb-4">Payment Method Mix</p>
            {loading ? (
              <Skeleton className="h-40 w-full rounded-xl" />
            ) : payPie.length === 0 ? (
              <Empty icon="◈" title="No payment data" desc="Appears once orders are placed" />
            ) : (
              <>
                <DonutChart data={payPie} />
                <div className="space-y-2 mt-4">
                  {payPie.map(p => (
                    <div key={p.name} className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: p.color }} />
                      <span className="text-[11px] text-muted flex-1">{p.name}</span>
                      <span className="text-[11px] font-bold text-cream">{p.value}%</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>

          <Card className="rounded-2xl border border-white/[0.06] p-5 shadow-sm">
            <p className="text-sm font-bold text-cream mb-4">Orders by Channel</p>
            {loading ? (
              <Skeleton className="h-40 w-full rounded-xl" />
            ) : Object.keys(bySource).length === 0 ? (
              <Empty icon="◩" title="No channel data" desc="Appears once orders are placed" />
            ) : (
              <div className="space-y-4">
                {Object.entries(bySource).map(([source, v]) => (
                  <div key={source}>
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <span className="font-semibold text-cream">{source}</span>
                      <div className="flex gap-3">
                        <span className="text-muted">{v.orders} orders</span>
                        <span className="font-bold text-gold"><Money amount={v.revenue} /></span>
                      </div>
                    </div>
                    <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gold rounded-full"
                        style={{ width: `${Math.round(v.revenue / (kpis.total_revenue || 1) * 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </motion.div>
      </motion.div>
    </div>
  )
}
