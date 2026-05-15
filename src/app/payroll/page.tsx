'use client'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { useHRDashboard } from '@/hooks/useHr'
import Link from 'next/link'
import { Card, KpiCard, Skeleton, Empty, Button } from '@/components/ui'

export default function PayrollPage() {
  const { data, loading } = useHRDashboard()
  const k = data?.kpis
  const roll = data?.employees_roll ?? []

  return (
    <FinancePageChrome
      title="Payroll"
      subtitle="Salary burden · advances · settlement health"
      actions={<Link href="/employees"><Button size="xs" variant="secondary">Employees</Button></Link>}
    >
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard label="Monthly salary budget" value={loading ? '—' : Number(k?.total_monthly_salary ?? 0)} loading={loading} />
        <KpiCard label="Unpaid (roll)" value={loading ? '—' : Number(k?.unpaid_salary_hint ?? 0)} loading={loading} />
        <KpiCard label="Outstanding advances" value={loading ? '—' : Number(k?.advance_outstanding ?? 0)} loading={loading} />
        <KpiCard label="Expenses (range)" value={loading ? '—' : Number(k?.total_expenses ?? 0)} loading={loading} />
        <KpiCard label="Net profit hint" value={loading ? '—' : Number(k?.net_business_profit_hint ?? 0)} color="text-green-400" loading={loading} />
      </div>

      <Card className="p-5">
        <p className="text-sm font-bold text-cream mb-4">Rolling balances</p>
        {loading ? <Skeleton className="h-40" /> : roll.length === 0 ? (
          <Empty icon="⌁" title="No active payroll" desc="Add employees then log advances or salary payouts" />
        ) : (
          <div className="overflow-x-auto max-h-[480px]">
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-card border-b border-border text-zinc-500">
                <tr>
                  <th className="py-2 pr-3">Employee</th>
                  <th className="py-2 pr-3 text-right">Salary</th>
                  <th className="py-2 pr-3 text-right">Paid</th>
                  <th className="py-2 pr-3 text-right">Advance</th>
                  <th className="py-2 pr-3 text-right">Due</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {roll.map(r => (
                  <tr key={r.emp_id} className="border-b border-border/60">
                    <td className="py-2 pr-3">{r.name}</td>
                    <td className="py-2 pr-3 font-mono text-right">৳ {r.monthly_salary.toLocaleString('en-BD')}</td>
                    <td className="py-2 pr-3 font-mono text-right text-zinc-400">৳ {r.salary_paid.toLocaleString('en-BD')}</td>
                    <td className="py-2 pr-3 font-mono text-right text-zinc-400">৳ {Math.max(0, r.advance_balance).toLocaleString('en-BD')}</td>
                    <td className="py-2 pr-3 font-mono text-right text-gold-lt">৳ {Math.max(0, r.current_due).toLocaleString('en-BD')}</td>
                    <td className="py-2"><Link href={`/employees/${r.emp_id}`} className="text-gold hover:underline">Detail</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5 overflow-hidden">
        <p className="text-sm font-bold text-cream mb-3">Timeline (recent)</p>
        {loading ? <Skeleton className="h-28" /> : !(data?.payroll_timeline ?? []).length ? (
          <p className="text-xs text-zinc-500">Record advances or payouts from employee detail screens.</p>
        ) : (
          <div className="divide-y divide-border max-h-64 overflow-y-auto text-[11px]">
            {(data!.payroll_timeline ?? []).map(tx => (
              <div key={tx.tx_id} className="py-2 flex justify-between gap-2">
                <span className="text-zinc-500 font-mono">{tx.date.slice(0, 10)}</span>
                <span className="flex-1 text-cream">{tx.emp_name} · {tx.tx_type.replace('_',' ')}</span>
                <span className="font-mono text-gold">৳ {tx.amount.toLocaleString('en-BD')}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </FinancePageChrome>
  )
}
