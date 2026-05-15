'use client'
import Link from 'next/link'
import { useBusiness } from '@/contexts/BusinessContext'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { useFinancialReport } from '@/hooks/useDigital'
import { useHRDashboard } from '@/hooks/useHr'
import { useDateRange } from '@/contexts/DateRangeContext'
import { Card, KpiCard, Skeleton, Empty, Money, Button } from '@/components/ui'
import { MonthlyRevenueChart } from '@/components/charts'
import { fmt, pct } from '@/lib/utils'

export default function FinanceHubPage() {
  const { business } = useBusiness()
  const { label } = useDateRange()
  const { data: report, loading: rLd } = useFinancialReport()
  const { data: hr, loading: hLd } = useHRDashboard()
  const pl = report?.profit_loss
  const k = hr?.kpis

  return (
    <FinancePageChrome
      title="Finance"
      subtitle={`${business.name} · ${label} · investor-ready operating view`}
      actions={(
        <div className="flex flex-wrap gap-2">
          <Link href="/expenses"><Button size="xs">Expenses</Button></Link>
          <Link href="/payroll"><Button size="xs">Payroll</Button></Link>
        </div>
      )}
    >
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Revenue (range)" value={rLd ? '—' : fmt(pl?.revenue ?? 0)} loading={rLd} />
        <KpiCard label="Expenses" value={rLd ? '—' : fmt(pl?.expenses ?? k?.total_expenses ?? 0)} loading={rLd} />
        <KpiCard label="Net profit" value={rLd ? '—' : fmt(pl?.net_profit ?? k?.net_business_profit_hint ?? 0)} color="text-green-400" loading={rLd} />
        <KpiCard label="Margin" value={rLd ? '—' : pct(pl?.margin_pct ?? 0)} loading={rLd} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Payroll budget" value={hLd ? '—' : fmt(k?.total_monthly_salary ?? 0)} loading={hLd} />
        <KpiCard label="Unpaid / due (roll)" value={hLd ? '—' : fmt(k?.unpaid_salary_hint ?? 0)} loading={hLd} />
        <KpiCard label="Advances out" value={hLd ? '—' : fmt(k?.advance_outstanding ?? 0)} loading={hLd} />
        <KpiCard label="Order gross profit" value={hLd ? '—' : fmt(k?.order_gross_profit ?? 0)} loading={hLd} />
      </div>

      <Card className="p-5">
        <p className="text-sm font-bold text-cream mb-1">Revenue & margin trend</p>
        <p className="text-[10px] text-zinc-500 mb-4">{report?.period_label ?? label}</p>
        {rLd ? <Skeleton className="h-48" /> : (report?.monthly_revenue ?? []).length === 0 ? (
          <Empty icon="◩" title="No range data" desc="Adjust the date filter or add orders / invoices" />
        ) : <MonthlyRevenueChart data={report!.monthly_revenue} />}
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-5 overflow-hidden">
          <p className="text-sm font-bold text-cream mb-3">Cashflow (report)</p>
          {rLd ? <Skeleton className="h-24" /> : (
            <div className="space-y-2 text-xs text-zinc-400">
              <div className="flex justify-between"><span>Inflow</span><span className="text-cream font-mono"><Money amount={report?.cashflow.inflow ?? 0} /></span></div>
              <div className="flex justify-between"><span>Outflow</span><span className="text-cream font-mono"><Money amount={report?.cashflow.outflow ?? 0} /></span></div>
              <div className="flex justify-between border-t border-border pt-2"><span className="text-gold-lt">Net</span><span className="text-gold-lt font-mono font-bold"><Money amount={report?.cashflow.net ?? 0} /></span></div>
            </div>
          )}
        </Card>
        <Card className="p-5 overflow-hidden">
          <p className="text-sm font-bold text-cream mb-3">Payroll snapshot</p>
          {hLd ? <Skeleton className="h-24" /> : (
            <div className="space-y-2 text-xs text-zinc-400">
              <div className="flex justify-between"><span>Period salary paid</span><span className="text-cream font-mono"><Money amount={k?.period_salary_paid ?? 0} /></span></div>
              <div className="flex justify-between"><span>Period advances</span><span className="text-cream font-mono"><Money amount={k?.period_advances ?? 0} /></span></div>
              <div className="flex justify-between border-t border-border pt-2"><span>Ledger expenses</span><span className="text-cream font-mono font-bold"><Money amount={k?.total_expenses ?? 0} /></span></div>
            </div>
          )}
        </Card>
      </div>
    </FinancePageChrome>
  )
}
