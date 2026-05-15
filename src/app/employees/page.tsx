'use client'
import Link from 'next/link'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { useHREmployees } from '@/hooks/useHr'
import { useHrSaveEmployee } from '@/hooks/useHr'
import { Card, Button, Skeleton, Empty } from '@/components/ui'
import { useState } from 'react'
import toast from 'react-hot-toast'

export default function EmployeesPage() {
  const { data, loading, refetch } = useHREmployees()
  const { mutate: saveEmp, loading: saving } = useHrSaveEmployee()
  const [open, setOpen] = useState(false)

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const payload = {
      emp_id: String(fd.get('emp_id') || '').trim(),
      name: String(fd.get('name') || ''),
      phone: String(fd.get('phone') || ''),
      email: String(fd.get('email') || ''),
      address: String(fd.get('address') || ''),
      role: String(fd.get('role') || ''),
      joining_date: String(fd.get('joining_date') || ''),
      monthly_salary: Number(fd.get('monthly_salary') || 0),
      status: String(fd.get('status') || 'Active'),
      notes: String(fd.get('notes') || ''),
    }
    if (!payload.name) {
      toast.error('Name is required')
      return
    }
    const clean: Record<string, unknown> = { ...payload }
    if (!clean.emp_id) delete clean.emp_id
    const res = await saveEmp(clean)
    if (res?.ok) {
      toast.success('Employee saved')
      setOpen(false)
      refetch()
      e.currentTarget.reset()
    }
  }

  return (
    <FinancePageChrome
      title="Employees"
      subtitle="HR registry · salaries · status"
      actions={<Button size="xs" variant="gold" onClick={() => setOpen(true)}>+ Add employee</Button>}
    >
      <Card className="overflow-hidden">
        <div className="p-4 border-b border-border flex justify-between items-center">
          <p className="text-xs text-zinc-500">{data?.total ?? 0} profiles · current business slice</p>
        </div>
        {loading ? <Skeleton className="h-64 m-4" /> : !(data?.employees ?? []).length ? (
          <Empty icon="◎" title="No employees yet" desc="Create your roster to unlock payroll tooling" />
        ) : (
          <div className="overflow-x-auto max-h-[70vh]">
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-card border-b border-border text-zinc-500">
                <tr>
                  <th className="py-2 px-4">ID</th>
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">Role</th>
                  <th className="py-2 pr-3">Salary</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-4"></th>
                </tr>
              </thead>
              <tbody>
                {(data!.employees).map(em => (
                  <tr key={em.emp_id} className="border-b border-border/60 hover:bg-white/[0.02]">
                    <td className="py-2 px-4 font-mono text-gold-dim">{em.emp_id}</td>
                    <td className="py-2 pr-3 text-cream">{em.name}</td>
                    <td className="py-2 pr-3">{em.role}</td>
                    <td className="py-2 pr-3 font-mono">৳ {em.monthly_salary.toLocaleString('en-BD')}</td>
                    <td className="py-2 pr-3">{em.status}</td>
                    <td className="py-2 pr-4">
                      <Link href={`/employees/${encodeURIComponent(em.emp_id)}`} className="text-gold-lt hover:underline">Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {open && (
        <div className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-sm flex items-end md:items-center justify-center p-4">
          <Card className="w-full max-w-lg p-5 max-h-[90vh] overflow-y-auto border-gold-dim/30">
            <p className="text-sm font-bold text-cream mb-4">Employee profile</p>
            <form onSubmit={submit} className="space-y-3 text-xs">
              <label className="block space-y-1">
                <span className="text-zinc-500">Existing ID (optional)</span>
                <input name="emp_id" className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream font-mono text-[11px]" placeholder="AUTO if empty" />
              </label>
              <label className="block space-y-1">
                <span className="text-zinc-500">Full name</span>
                <input name="name" required className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream text-sm" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className="text-zinc-500">Phone</span>
                  <input name="phone" className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream font-mono text-sm" />
                </label>
                <label className="block space-y-1">
                  <span className="text-zinc-500">Email</span>
                  <input name="email" type="email" className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream text-sm" />
                </label>
              </div>
              <label className="block space-y-1">
                <span className="text-zinc-500">Address</span>
                <textarea name="address" rows={2} className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream text-sm" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className="text-zinc-500">Role</span>
                  <input name="role" className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream text-sm" />
                </label>
                <label className="block space-y-1">
                  <span className="text-zinc-500">Joining date</span>
                  <input name="joining_date" type="date" className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream font-mono text-sm" />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className="text-zinc-500">Monthly salary</span>
                  <input name="monthly_salary" type="number" step="0.01" className="w-full rounded-xl bg-card border border-border px-3 py-2 font-mono text-sm" />
                </label>
                <label className="block space-y-1">
                  <span className="text-zinc-500">Status</span>
                  <select name="status" className="w-full rounded-xl bg-card border border-border px-3 py-2 text-sm text-cream">
                    <option>Active</option>
                    <option>Inactive</option>
                    <option>Probation</option>
                  </select>
                </label>
              </div>
              <label className="block space-y-1">
                <span className="text-zinc-500">Notes</span>
                <textarea name="notes" rows={3} className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream text-sm" />
              </label>
              <div className="flex gap-2 pt-2">
                <Button type="submit" variant="gold" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </FinancePageChrome>
  )
}
