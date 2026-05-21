'use client'
import Link from 'next/link'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { useHREmployees } from '@/hooks/useHr'
import { useHrSaveEmployee } from '@/hooks/useHr'
import { Card, Button, Skeleton, Empty } from '@/components/ui'
import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { useBusiness } from '@/contexts/BusinessContext'
import { safeFetchJsonWithToast } from '@/lib/safe-fetch'
import { displayBdPhone } from '@/lib/phone'
import type { UserRole } from '@prisma/client'

type LinkableUser = {
  id: string
  name: string
  email: string | null
  phone: string | null
  role: UserRole
  businessAccess: string
  employeeIdGas: string | null
  salaryHint: string | number | null
  joiningDate: string | null
  linked: boolean
  linkedEmployeeId: string | null
  matchedEmployeeId: string | null
  matchedEmployeeName: string | null
  selectable: boolean
}

export default function EmployeesPage() {
  const { data, loading, refetch } = useHREmployees()
  const { mutate: saveEmp, loading: saving } = useHrSaveEmployee()
  const { business } = useBusiness()
  const [open, setOpen] = useState(false)
  const [users, setUsers] = useState<LinkableUser[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [selectedUserId, setSelectedUserId] = useState('')

  const selectedUser = useMemo(() => users.find(u => u.id === selectedUserId) || null, [selectedUserId, users])

  const loadUsers = useCallback(async () => {
    setUsersLoading(true)
    try {
      const result = await safeFetchJsonWithToast<{ users?: LinkableUser[] }>(
        `/api/hr/employees?business_id=${business.id}&include_users=1`,
        { cache: 'no-store', toastOnError: false },
      )
      if (!result.ok) throw new Error(result.error.message)
      setUsers(result.data.users || [])
    } catch (e) {
      toast.error((e as Error).message || 'Could not load users')
      setUsers([])
    } finally {
      setUsersLoading(false)
    }
  }, [business.id])

  useEffect(() => {
    if (!open) return
    void loadUsers()
  }, [open, loadUsers])

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
      user_id: selectedUserId || undefined,
      business_id: business.id,
    }
    if (!payload.name) {
      toast.error('Name is required')
      return
    }
    if (selectedUser?.employeeIdGas && selectedUser.employeeIdGas !== payload.emp_id) {
      toast.error(`${selectedUser.name} is already linked to ${selectedUser.employeeIdGas}`)
      return
    }
    const clean: Record<string, unknown> = { ...payload }
    if (!clean.emp_id) delete clean.emp_id
    const res = await saveEmp(clean)
    if (res?.ok) {
      toast.success('Employee saved')
      setOpen(false)
      setSelectedUserId('')
      refetch()
      void loadUsers()
      e.currentTarget.reset()
    } else {
      toast.error('Employee save failed')
    }
  }

  function fillFromUser(user: LinkableUser) {
    setSelectedUserId(user.id)
    requestAnimationFrame(() => {
      const form = document.getElementById('employee-create-form') as HTMLFormElement | null
      if (!form) return
      const set = (name: string, value: string) => {
        const el = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null
        if (el) el.value = value
      }
      set('name', user.name)
      set('phone', user.phone || '')
      set('email', user.email || '')
      set('role', user.role.replace(/_/g, ' '))
      set('joining_date', user.joiningDate ? String(user.joiningDate).slice(0, 10) : '')
      set('monthly_salary', user.salaryHint ? String(user.salaryHint) : '')
      if (user.employeeIdGas || user.matchedEmployeeId) set('emp_id', user.employeeIdGas || user.matchedEmployeeId || '')
    })
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
          <div className="table-scroll max-h-[70vh]">
            <table className="w-full min-w-[760px] text-left text-[11px]">
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
          <Card className="w-full max-w-5xl p-5 max-h-[90vh] overflow-y-auto border-gold-dim/30">
            <div className="flex justify-between gap-3 items-start mb-4">
              <div>
                <p className="text-sm font-bold text-cream">Employee profile</p>
                <p className="text-[11px] text-zinc-500 mt-1">Create a roster profile manually or directly from an unlinked system user.</p>
              </div>
              <Button type="button" size="xs" variant="secondary" onClick={() => void loadUsers()} disabled={usersLoading}>Refresh users</Button>
            </div>

            <div className="grid lg:grid-cols-[1.05fr_1fr] gap-4">
              <div className="rounded-2xl border border-border bg-black/20 p-3">
                <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold mb-3">Create Employee From User</p>
                {usersLoading ? (
                  <Skeleton className="h-40 w-full" />
                ) : !users.length ? (
                  <p className="text-[11px] text-zinc-500">No users available in this business scope.</p>
                ) : (
                  <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                    {users.map(user => (
                      <button
                        key={user.id}
                        type="button"
                        onClick={() => fillFromUser(user)}
                        disabled={!user.selectable}
                        className={`w-full rounded-xl border p-3 text-left transition-colors ${selectedUserId === user.id ? 'border-gold-dim/60 bg-gold/10' : user.selectable ? 'border-border bg-card hover:border-gold-dim/40' : 'border-border bg-black/20 opacity-70'}`}
                      >
                        <div className="flex justify-between gap-2 items-start">
                          <div className="min-w-0">
                            <p className="text-sm font-bold text-cream truncate">{user.name}</p>
                            <p className="text-[10px] text-zinc-500 font-mono truncate">{user.email || user.phone || 'No contact'}</p>
                          </div>
                          <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold ${user.linked ? 'border-green-400/30 text-green-400 bg-green-400/10' : 'border-amber-400/30 text-amber-300 bg-amber-400/10'}`}>
                            {user.linked ? `Linked ${user.linkedEmployeeId}` : 'Unlinked'}
                          </span>
                        </div>
                        <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-zinc-500">
                          <span>{user.role.replace(/_/g, ' ')}</span>
                          <span className="font-mono">{user.phone ? displayBdPhone(user.phone) : 'No phone'}</span>
                          <span className="truncate" title={user.businessAccess}>{user.businessAccess.replace(/,/g, ', ')}</span>
                        </div>
                        {user.matchedEmployeeId && !user.linked && (
                          <p className="mt-2 text-[10px] text-amber-300">Possible existing employee: {user.matchedEmployeeName} · {user.matchedEmployeeId}</p>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

            <form id="employee-create-form" onSubmit={submit} className="space-y-3 text-xs">
              {selectedUser && (
                <div className="rounded-2xl border border-gold-dim/30 bg-gold/[0.05] p-3">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gold">Selected user</p>
                  <p className="mt-1 text-sm font-bold text-cream">{selectedUser.name}</p>
                  <p className="text-[11px] text-zinc-500">{selectedUser.role.replace(/_/g, ' ')} · {selectedUser.businessAccess.replace(/,/g, ', ')}</p>
                  {selectedUser.linked && <p className="mt-1 text-[11px] text-green-400">Already linked to {selectedUser.linkedEmployeeId}. Duplicate links are blocked.</p>}
                </div>
              )}
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
                <Button type="submit" variant="gold" disabled={saving || Boolean(selectedUser?.linked && selectedUser.employeeIdGas)}>
                  {saving ? 'Saving…' : selectedUser ? 'Create Employee From User' : 'Save'}
                </Button>
                <Button type="button" variant="ghost" onClick={() => { setOpen(false); setSelectedUserId('') }}>Cancel</Button>
              </div>
            </form>
            </div>
          </Card>
        </div>
      )}
    </FinancePageChrome>
  )
}
