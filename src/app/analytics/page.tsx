'use client'
import { useDashboard } from '@/hooks/useERP'
import { PageHeader, Card, KpiCard, GoldDivider } from '@/components/ui'
import { RevenueChart, ExpenseBarChart, DonutChart } from '@/components/charts'
import { fmt, pct } from '@/lib/utils'
import { MobileNav } from '@/components/layout/Sidebar'
import { REVENUE_TREND, MOCK_DASHBOARD, EXPENSE_DATA } from '@/lib/data'

const PAYMENT_PIE = [{ name:'COD', value:50, color:'#F5A623' }, { name:'bKash', value:40, color:'#E8357A' }, { name:'Nagad', value:10, color:'#F46223' }]

export default function AnalyticsPage() {
  const { data, loading } = useDashboard()
  const d = data ?? MOCK_DASHBOARD
  const kpis = d.kpis

  const catArr = Object.entries(d.by_category).map(([name, v]) => ({
    name, ...v, margin: v.revenue > 0 ? Math.round(v.profit / v.revenue * 100) : 0
  })).sort((a, b) => b.revenue - a.revenue)

  return (
    <>
      <PageHeader title="Analytics" subtitle="Revenue intelligence · Category performance · Ad ROI" />

      <div className="p-4 md:p-6 pb-24 md:pb-6 space-y-6">

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="Total Revenue"    value={fmt(kpis.total_revenue)}    color="text-gold-lt"   delta={18} loading={loading} />
          <KpiCard label="Net Profit"       value={fmt(kpis.total_profit)}     color="text-green-400" delta={12} loading={loading} />
          <KpiCard label="Gross Margin"     value={pct(kpis.gross_margin)}     color="text-gold"      loading={loading} />
          <KpiCard label="Avg Order Value"  value={fmt(kpis.avg_order_value)}  loading={loading} />
        </div>

        {/* Revenue trend + Expense */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="p-5">
            <p className="text-sm font-bold text-cream mb-1">Revenue vs Profit Trend</p>
            <p className="text-[10px] text-zinc-500 mb-4">Last 5 months</p>
            <RevenueChart data={REVENUE_TREND} />
          </Card>
          <Card className="p-5">
            <p className="text-sm font-bold text-cream mb-1">Expense Breakdown</p>
            <p className="text-[10px] text-zinc-500 mb-4">৳{(EXPENSE_DATA.reduce((a,e)=>a+e.amount,0)/1000).toFixed(0)}k total this period</p>
            <ExpenseBarChart data={EXPENSE_DATA} />
          </Card>
        </div>

        {/* Category performance */}
        <Card className="overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <p className="text-sm font-bold text-cream">Category Performance</p>
          </div>
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
                        <div className="w-2 h-2 rounded-sm" style={{ background: ['#C9A84C','#8B6914','#E8C96A','#6B5530','#4A3A20'][i] || '#3D3020' }} />
                        <span className="font-semibold text-cream">{c.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-zinc-400">{c.orders}</td>
                    <td className="px-4 py-3.5 font-bold text-cream tabular-nums">{fmt(c.revenue)}</td>
                    <td className="px-4 py-3.5 font-bold text-green-400 tabular-nums">{fmt(c.profit)}</td>
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
        </Card>

        {/* Payment + Source */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="p-5">
            <p className="text-sm font-bold text-cream mb-4">Payment Method Mix</p>
            <DonutChart data={PAYMENT_PIE} />
            <div className="space-y-2 mt-4">
              {PAYMENT_PIE.map(p => (
                <div key={p.name} className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: p.color }} />
                  <span className="text-[11px] text-zinc-400 flex-1">{p.name}</span>
                  <span className="text-[11px] font-bold">{p.value}%</span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-5">
            <p className="text-sm font-bold text-cream mb-4">Ad Performance</p>
            <div className="space-y-4">
              {Object.entries(d.by_source).map(([source, v]) => (
                <div key={source}>
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <span className="font-semibold text-cream">{source}</span>
                    <div className="flex gap-3">
                      <span className="text-zinc-500">{v.orders} orders</span>
                      <span className="font-bold text-gold">{fmt(v.revenue)}</span>
                    </div>
                  </div>
                  <div className="h-1.5 bg-border rounded-full overflow-hidden">
                    <div className="h-full bg-gold rounded-full" style={{ width: `${Math.round(v.revenue / (kpis.total_revenue || 1) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <GoldDivider className="mt-4 mb-3" />
            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">Total Ad Spend</span>
              <span className="font-bold text-gold">৳25,000</span>
            </div>
            <div className="flex justify-between text-xs mt-1">
              <span className="text-zinc-500">Ad ROI</span>
              <span className="font-bold text-green-400">1.6×</span>
            </div>
          </Card>
        </div>

      </div>
      <MobileNav />
    </>
  )
}
