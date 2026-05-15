'use client'
import { useAnalyticsMerged } from '@/hooks/useERP'
import { DateRangeFilter } from '@/components/date-filter/DateRangeFilter'
import { PageHeader, Card, KpiCard, GoldDivider, Skeleton, Empty , Money, BdtText} from '@/components/ui'
import { RevenueChart, ExpenseBarChart, DonutChart } from '@/components/charts'
import { formatBDTk } from '@/lib/currency'
import { fmt, pct } from '@/lib/utils'

const PALETTE = ['#C9A84C','#8B6914','#E8C96A','#6B5530','#4A3A20','#3D3020']

// Payment pie is derived from live by_payment data, not hardcoded
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
    color: COLORS[name] ?? '#888',
  }))
}

// Expense bar data from live by_category
function expenseBar(byCat: Record<string, number>) {
  const colors = ['#C9A84C','#8B6914','#E8C96A','#6B5530','#4A3A20','#3D3020','#2A1A08','#1A0A00']
  return Object.entries(byCat)
    .sort(([, a], [, b]) => b - a)
    .map(([category, amount], i) => ({ category, amount, color: colors[i] ?? '#888' }))
}

export default function AnalyticsPage() {
  const { data, loading } = useAnalyticsMerged()

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
    <>
      <PageHeader title="Analytics" subtitle="Revenue · expenses · payroll context — synced to filters" />

      <div className="p-4 md:p-6 pb-24 md:pb-6 space-y-6">
        <DateRangeFilter />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="Total Revenue"   value={loading ? '—' : fmt(kpis.total_revenue)}   color="text-gold-lt"   loading={loading} />
          <KpiCard label="Net Profit"      value={loading ? '—' : fmt(kpis.total_profit)}    color="text-green-400" loading={loading} />
          <KpiCard label="Gross Margin"    value={loading ? '—' : pct(kpis.gross_margin)}    color="text-gold"      loading={loading} />
          <KpiCard label="Avg Order Value" value={loading ? '—' : fmt(kpis.avg_order_value)} loading={loading} />
        </div>

        {/* Revenue trend + Expense breakdown */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="p-5">
            <p className="text-sm font-bold text-cream mb-1">Revenue vs Profit Trend</p>
            <p className="text-[10px] text-zinc-500 mb-4">Monthly · live data</p>
            {loading ? (
              <Skeleton className="h-48 w-full rounded-xl" />
            ) : monthlyTrend.length === 0 ? (
              <Empty icon="◈" title="No trend data yet" desc="Revenue chart appears after orders are placed" />
            ) : (
              <RevenueChart data={monthlyTrend} />
            )}
          </Card>

          <Card className="p-5">
            <p className="text-sm font-bold text-cream mb-1">Expense Breakdown</p>
            <p className="text-[10px] text-zinc-500 mb-4">
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
        </div>

        {/* Category performance table */}
        <Card className="overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <p className="text-sm font-bold text-cream">Category Performance</p>
          </div>
          {loading ? (
            <div className="p-5 space-y-3">
              {Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-8 w-full rounded-lg" />)}
            </div>
          ) : catArr.length === 0 ? (
            <div className="p-5"><Empty icon="◧" title="No category data" desc="Appears once orders are placed" /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    {['Category','Orders','Revenue','Profit','Margin'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-[10px] font-bold tracking-[0.08em] uppercase text-zinc-500">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {catArr.map((c, i) => (
                    <tr key={c.name} className="border-b border-border/50 hover:bg-white/[0.015] transition-colors">
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-2.5">
                          <div className="w-2 h-2 rounded-sm" style={{ background: PALETTE[i] ?? '#3D3020' }} />
                          <span className="font-semibold text-cream">{c.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-zinc-400">{c.orders}</td>
                      <td className="px-4 py-3.5 font-bold text-cream tabular-nums"><Money amount={c.revenue} /></td>
                      <td className="px-4 py-3.5 font-bold text-green-400 tabular-nums"><Money amount={c.profit} /></td>
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1 bg-border rounded-full overflow-hidden w-16">
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

        {/* Payment mix + Source performance */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="p-5">
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
                      <span className="text-[11px] text-zinc-400 flex-1">{p.name}</span>
                      <span className="text-[11px] font-bold">{p.value}%</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>

          <Card className="p-5">
            <p className="text-sm font-bold text-cream mb-4">Orders by Channel</p>
            {loading ? (
              <Skeleton className="h-40 w-full rounded-xl" />
            ) : Object.keys(bySource).length === 0 ? (
              <Empty icon="◩" title="No channel data" desc="Appears once orders are placed" />
            ) : (
              <>
                <div className="space-y-4">
                  {Object.entries(bySource).map(([source, v]) => (
                    <div key={source}>
                      <div className="flex items-center justify-between text-xs mb-1.5">
                        <span className="font-semibold text-cream">{source}</span>
                        <div className="flex gap-3">
                          <span className="text-zinc-500">{v.orders} orders</span>
                          <span className="font-bold text-gold"><Money amount={v.revenue} /></span>
                        </div>
                      </div>
                      <div className="h-1.5 bg-border rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gold rounded-full"
                          style={{ width: `${Math.round(v.revenue / (kpis.total_revenue || 1) * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>
        </div>

      </div>
    </>
  )
}
// force redeploy 2