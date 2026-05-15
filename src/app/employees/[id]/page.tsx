'use client'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { useHREmployees, useHRPayrollForEmployee, useHrAddPayroll } from '@/hooks/useHr'
import { computePayrollRoll } from '@/lib/hr-payroll-roll'
import { useBranding } from '@/contexts/BrandingContext'
import { useBusiness } from '@/contexts/BusinessContext'
import { useDateRange } from '@/contexts/DateRangeContext'
import { Card, Button, Skeleton, Empty } from '@/components/ui'
import { SalarySlipToolbar } from '@/components/finance/SalarySlipToolbar'
import type { SalarySlipModel } from '@/components/pdf/SalarySlipDocument'
import { useMemo, useState } from 'react'
import toast from 'react-hot-toast'

export default function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>()
  const decoded = decodeURIComponent(id || '')
  const { data: list, loading: listLoading } = useHREmployees()
  const { data: txs, loading, refetch } = useHRPayrollForEmployee(decoded || null)
  const { mutate: postPay, loading: paying } = useHrAddPayroll()
  const { branding } = useBranding()
  const { business } = useBusiness()
  const { label } = useDateRange()
  const [openPay, setOpenPay] = useState(false)

  const employee = list?.employees.find(e => e.emp_id === decoded)
  const transactions = txs?.transactions ?? []
  const roll = useMemo(
    () => (employee ? computePayrollRoll(employee, transactions) : null),
    [employee, transactions],
  )

  const slipModel: SalarySlipModel | null =
    employee && roll
      ? {
          companyName: branding?.company_name ?? business.name,
          tagline: branding?.tagline ?? business.tagline,
          logoUrl: branding?.logo_url || null,
          employee,
          periodLabel: label,
          roll,
          generatedAt: new Date().toISOString().slice(0, 10),
        }
      : null

  async function submitPay(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!employee) return
    const fd = new FormData(e.currentTarget)
    const payload = {
      emp_id: employee.emp_id,
      tx_type: String(fd.get('tx_type') || ''),
      amount: Number(fd.get('amount') || 0),
      date: String(fd.get('date') || ''),
      period_ym: String(fd.get('period_ym') || ''),
      note: String(fd.get('note') || ''),
    }
    if (!payload.tx_type || !payload.amount) {
      toast.error('Transaction type & amount required')
      return
    }
    const res = await postPay(payload)
    if (res?.ok) {
      toast.success('Payroll logged')
      setOpenPay(false)
      refetch()
      e.currentTarget.reset()
    }
  }

  if (listLoading) {
    return (
      <FinancePageChrome title="Employee" subtitle="Profile & payroll ledger">
        <Skeleton className="h-48" />
      </FinancePageChrome>
    )
  }

  if (!employee) {
    return (
      <FinancePageChrome title="Employee" subtitle="Profile & payroll ledger">
        <Empty icon="◎" title="Not found" desc="Return to roster and choose an employee." />
        <div className="text-center mt-4">
          <Link href="/employees" className="text-gold-lt underline text-sm">← Employees</Link>
        </div>
      </FinancePageChrome>
    )
  }

  return (
    <FinancePageChrome
      title={employee.name}
      subtitle={`${employee.role || 'Contributor'} · ${employee.emp_id}`}
    >
      <Card className="p-5 space-y-2 text-xs text-zinc-400 mb-4">
        <div className="flex flex-wrap justify-between gap-3">
          <div>
            <p className="text-cream text-sm font-bold">{employee.name}</p>
            <p>{employee.phone || '—'} · {employee.email || 'No email on file'}</p>
            <p className="mt-1">{employee.address}</p>
          </div>
          <div className="text-right space-y-1 font-mono text-gold-lt">
            <p>Salary ৳ {employee.monthly_salary.toLocaleString('en-BD')}</p>
            <p>Paid ৳ {roll?.salary_paid.toLocaleString('en-BD') ?? '—'}</p>
            <p>Advance ৳ {Math.max(0, roll?.advance_balance ?? 0).toLocaleString('en-BD')}</p>
            <p className="text-cream font-bold">Due ৳ {Math.max(0, roll?.current_due ?? 0).toLocaleString('en-BD')}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 pt-3 justify-between items-center border-t border-border">
          {slipModel ? <SalarySlipToolbar model={slipModel} /> : null}
          <Link href="/employees" className="text-[11px] text-zinc-500 hover:text-cream underline">← Roster</Link>
        </div>
      </Card>

      <div className="flex justify-end mb-3">
        <Button size="xs" variant="gold" onClick={() => setOpenPay(true)}>+ Payroll entry</Button>
      </div>

      <Card className="p-5">
        <p className="text-sm font-bold text-cream mb-3">Permanent payroll history</p>
        {loading ? <Skeleton className="h-44" /> : transactions.length === 0 ? (
          <p className="text-xs text-zinc-500">No transactions logged yet.</p>
        ) : (
          <div className="overflow-x-auto max-h-96 overflow-y-auto text-[11px]">
            <table className="w-full">
              <thead className="sticky top-0 bg-card border-b border-border text-zinc-500">
                <tr>
                  <th className="py-2 pr-3 text-left">Date</th>
                  <th className="py-2 pr-3 text-left">Type</th>
                  <th className="py-2 pr-3 text-right">৳</th>
                  <th className="py-2 pr-3 text-left">Period</th>
                  <th className="py-2 text-left">Note</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map(tx => (
                  <tr key={tx.tx_id} className="border-b border-border/60">
                    <td className="py-2 pr-3 font-mono">{tx.date.slice(0, 10)}</td>
                    <td className="py-2 pr-3">{tx.tx_type}</td>
                    <td className="py-2 pr-3 text-right font-mono text-gold-lt">{tx.amount.toLocaleString('en-BD')}</td>
                    <td className="py-2 pr-3">{tx.period_ym}</td>
                    <td className="py-2 text-zinc-500">{tx.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {openPay && (
        <div className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-sm flex items-end md:items-center justify-center p-4">
          <Card className="w-full max-w-md p-5 border-gold-dim/30 space-y-3">
            <p className="text-sm font-bold text-cream">Log payroll movement</p>
            <form onSubmit={submitPay} className="space-y-3 text-xs">
              <label className="block space-y-1">
                <span className="text-zinc-500">Type</span>
                <select name="tx_type" className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream text-sm" required>
                  <option value="advance">advance</option>
                  <option value="deposit">deposit</option>
                  <option value="salary_payment">salary_payment</option>
                  <option value="adjustment">adjustment</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-zinc-500">Amount (৳)</span>
                <input name="amount" type="number" step="0.01" required className="w-full rounded-xl bg-card border border-border px-3 py-2 font-mono text-sm" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className="text-zinc-500">Effective date</span>
                  <input name="date" type="date" className="w-full rounded-xl bg-card border border-border px-3 py-2 font-mono text-sm" />
                </label>
                <label className="block space-y-1">
                  <span className="text-zinc-500">Period (YYYY-MM)</span>
                  <input name="period_ym" placeholder="2026-05" className="w-full rounded-xl bg-card border border-border px-3 py-2 font-mono text-sm" />
                </label>
              </div>
              <label className="block space-y-1">
                <span className="text-zinc-500">Note</span>
                <textarea name="note" rows={2} className="w-full rounded-xl bg-card border border-border px-3 py-2 text-sm text-cream" />
              </label>
              <div className="flex gap-2">
                <Button type="submit" variant="gold" disabled={paying}>{paying ? 'Saving…' : 'Save entry'}</Button>
                <Button type="button" variant="ghost" onClick={() => setOpenPay(false)}>Cancel</Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </FinancePageChrome>
  )
}
