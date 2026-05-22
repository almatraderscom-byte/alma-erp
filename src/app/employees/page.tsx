'use client'
import Link from 'next/link'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
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
  linkState?: 'linked' | 'orphan' | 'unlinked'
  linkedEmployeeId: string | null
  orphanEmployeeId?: string | null
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
  const [linkRosterEmpId, setLinkRosterEmpId] = useState<string | null>(null)
  const [linkUserId, setLinkUserId] = useState('')
  const [linkBusy, setLinkBusy] = useState(false)
  const [orphanLinkEmpId, setOrphanLinkEmpId] = useState('')

  const selectedUser = useMemo(() => users.find(u => u.id === selectedUserId) || null, [selectedUserId, users])
  const usersByEmployeeId = useMemo(() => {
    const map = new Map<string, LinkableUser>()
    users.forEach(u => {
      if (u.linked && u.linkedEmployeeId) map.set(u.linkedEmployeeId, u)
    })
    return map
  }, [users])
  const unlinkableUsers = useMemo(
    () => users.filter(u => !u.linked && !u.orphanEmployeeId),
    [users],
  )

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
    void loadUsers()
  }, [loadUsers])

  useEffect(() => {
    if (!open) return
    void loadUsers()
  }, [open, loadUsers])

  async function patchUserLink(body: Record<string, string>) {
    const result = await safeFetchJsonWithToast('/api/hr/employees/link', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_id: business.id, ...body }),
    })
    if (!result.ok) throw new Error(result.error.message)
    await loadUsers()
    refetch()
  }

  async function clearOrphanLink(user: LinkableUser) {
    if (!user.orphanEmployeeId) return
    try {
      await patchUserLink({ action: 'clear_user_link', user_id: user.id })
      toast.success('Stale employee ID cleared — you can create a new roster row from this user')
      if (selectedUserId === user.id) setSelectedUserId(user.id)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function linkOrphanToRoster(user: LinkableUser) {
    if (!orphanLinkEmpId) {
      toast.error('Select a roster employee to link')
      return
    }
    try {
      await patchUserLink({
        action: 'link_user_to_employee',
        user_id: user.id,
        employee_id: orphanLinkEmpId,
      })
      toast.success(`Linked ${user.name} to ${orphanLinkEmpId}`)
      setOrphanLinkEmpId('')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function linkRosterToUser() {
    if (!linkRosterEmpId || !linkUserId) {
      toast.error('Select a user account')
      return
    }
    setLinkBusy(true)
    try {
      await patchUserLink({
        action: 'link_user_to_employee',
        user_id: linkUserId,
        employee_id: linkRosterEmpId,
      })
      toast.success('Roster row linked to user')
      setLinkRosterEmpId(null)
      setLinkUserId('')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLinkBusy(false)
    }
  }

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
    if (selectedUser?.linked && selectedUser.employeeIdGas && selectedUser.employeeIdGas !== payload.emp_id) {
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
      if (!user.orphanEmployeeId && (user.employeeIdGas || user.matchedEmployeeId)) {
        set('emp_id', user.employeeIdGas || user.matchedEmployeeId || '')
      } else {
        set('emp_id', '')
      }
    })
  }

  const rosterEmployees = data?.employees ?? []

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
        {loading ? <Skeleton className="h-64 m-4" /> : !rosterEmployees.length ? (
          <Empty icon="◎" title="No employees yet" desc="Create your roster to unlock payroll tooling" />
        ) : (
          <div className="table-scroll max-h-[70vh]">
            <table className="w-full min-w-[860px] text-left text-[11px]">
              <thead className="sticky top-0 bg-card border-b border-border text-zinc-500">
                <tr>
                  <th className="py-2 px-4">ID</th>
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">Role</th>
                  <th className="py-2 pr-3">Salary</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-4">Account</th>
                  <th className="py-2 pr-4"></th>
                </tr>
              </thead>
              <tbody>
                {rosterEmployees.map(em => {
                  const linkedUser = usersByEmployeeId.get(em.emp_id)
                  return (
                    <tr key={em.emp_id} className="border-b border-border/60 hover:bg-white/[0.02]">
                      <td className="py-2 px-4 font-mono text-gold-dim">{em.emp_id}</td>
                      <td className="py-2 pr-3 text-cream">{em.name}</td>
                      <td className="py-2 pr-3">{em.role}</td>
                      <td className="py-2 pr-3 font-mono">৳ {em.monthly_salary.toLocaleString('en-BD')}</td>
                      <td className="py-2 pr-3">{em.status}</td>
                      <td className="py-2 pr-3 text-zinc-500">
                        {linkedUser ? (
                          <span className="text-green-400">{linkedUser.name}</span>
                        ) : (
                          <Button
                            size="xs"
                            variant="secondary"
                            type="button"
                            onClick={() => {
                              setLinkRosterEmpId(em.emp_id)
                              setLinkUserId('')
                            }}
                          >
                            Link to user account
                          </Button>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        <Link href={`/employees/${encodeURIComponent(em.emp_id)}`} className="text-gold-lt hover:underline">Open</Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {linkRosterEmpId && (
        <MobileModalPortal open zIndex={110} onBackdropClick={() => setLinkRosterEmpId(null)}>
          <Card className="mobile-modal-shell w-full max-w-md border-gold-dim/30 p-5">
            <p className="text-sm font-bold text-cream">Link roster row to user</p>
            <p className="text-[11px] text-zinc-500 mt-1 font-mono">{linkRosterEmpId}</p>
            <label className="block mt-4 text-[11px] text-zinc-500">
              User without employee link
              <select
                value={linkUserId}
                onChange={e => setLinkUserId(e.target.value)}
                className="mt-1 w-full rounded-xl border border-border bg-black/30 px-3 py-2 text-cream"
              >
                <option value="">Select user</option>
                {unlinkableUsers.map(u => (
                  <option key={u.id} value={u.id}>{u.name} · {u.role.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </label>
            <div className="flex gap-2 mt-4">
              <Button size="xs" variant="gold" disabled={linkBusy} onClick={() => void linkRosterToUser()}>
                {linkBusy ? 'Linking…' : 'Link'}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setLinkRosterEmpId(null)}>Cancel</Button>
            </div>
          </Card>
        </MobileModalPortal>
      )}

      {open && (
        <MobileModalPortal open zIndex={120} onBackdropClick={() => { setOpen(false); setSelectedUserId('') }}>
          <Card className="mobile-modal-shell w-full max-w-5xl border-gold-dim/30 sm:rounded-2xl">
            <div className="mobile-modal-header p-5 pb-3">
              <div className="flex justify-between gap-3 items-start">
                <div>
                  <p className="text-sm font-bold text-cream">Employee profile</p>
                  <p className="text-[11px] text-zinc-500 mt-1">Create a roster profile manually or directly from an unlinked system user.</p>
                </div>
                <Button type="button" size="xs" variant="secondary" onClick={() => void loadUsers()} disabled={usersLoading}>Refresh users</Button>
              </div>
            </div>

            <form id="employee-create-form" onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <div className="mobile-modal-body px-5 pb-4">
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
                      <div
                        key={user.id}
                        className={`rounded-xl border p-3 ${selectedUserId === user.id ? 'border-gold-dim/60 bg-gold/10' : user.selectable ? 'border-border bg-card' : 'border-border bg-black/20 opacity-80'}`}
                      >
                        <button
                          type="button"
                          onClick={() => user.selectable && fillFromUser(user)}
                          disabled={!user.selectable}
                          className="w-full text-left"
                        >
                          <div className="flex justify-between gap-2 items-start">
                            <div className="min-w-0">
                              <p className="text-sm font-bold text-cream truncate">{user.name}</p>
                              <p className="text-[10px] text-zinc-500 font-mono truncate">{user.email || user.phone || 'No contact'}</p>
                            </div>
                            <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold shrink-0 ${
                              user.linkState === 'linked'
                                ? 'border-green-400/30 text-green-400 bg-green-400/10'
                                : user.linkState === 'orphan'
                                  ? 'border-red-400/30 text-red-300 bg-red-400/10'
                                  : 'border-amber-400/30 text-amber-300 bg-amber-400/10'
                            }`}>
                              {user.linkState === 'linked'
                                ? `Linked ${user.linkedEmployeeId}`
                                : user.linkState === 'orphan'
                                  ? 'Stale ID'
                                  : 'Unlinked'}
                            </span>
                          </div>
                          <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-zinc-500">
                            <span>{user.role.replace(/_/g, ' ')}</span>
                            <span className="font-mono">{user.phone ? displayBdPhone(user.phone) : 'No phone'}</span>
                            <span className="truncate" title={user.businessAccess}>{user.businessAccess.replace(/,/g, ', ')}</span>
                          </div>
                          {user.matchedEmployeeId && user.linkState === 'unlinked' && (
                            <p className="mt-2 text-[10px] text-amber-300">Possible existing employee: {user.matchedEmployeeName} · {user.matchedEmployeeId}</p>
                          )}
                        </button>
                        {user.linkState === 'orphan' && user.orphanEmployeeId && (
                          <div className="mt-3 pt-3 border-t border-border/60 space-y-2">
                            <p className="text-[10px] text-red-300">
                              User has stale employee ID: <span className="font-mono">{user.orphanEmployeeId}</span>. Re-link or clear?
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <Button size="xs" variant="secondary" type="button" onClick={() => void clearOrphanLink(user)}>
                                Clear and create new
                              </Button>
                            </div>
                            <div className="flex gap-2 items-center">
                              <select
                                value={selectedUserId === user.id ? orphanLinkEmpId : ''}
                                onChange={e => {
                                  setSelectedUserId(user.id)
                                  setOrphanLinkEmpId(e.target.value)
                                }}
                                className="flex-1 rounded-lg border border-border bg-black/30 px-2 py-1.5 text-[10px] text-cream"
                              >
                                <option value="">Link to roster row…</option>
                                {rosterEmployees.map(em => (
                                  <option key={em.emp_id} value={em.emp_id}>{em.name} · {em.emp_id}</option>
                                ))}
                              </select>
                              <Button
                                size="xs"
                                variant="gold"
                                type="button"
                                disabled={selectedUserId !== user.id || !orphanLinkEmpId}
                                onClick={() => void linkOrphanToRoster(user)}
                              >
                                Link
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

            <div className="space-y-3 text-xs">
              {selectedUser && (
                <div className="rounded-2xl border border-gold-dim/30 bg-gold/[0.05] p-3">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gold">Selected user</p>
                  <p className="mt-1 text-sm font-bold text-cream">{selectedUser.name}</p>
                  <p className="text-[11px] text-zinc-500">{selectedUser.role.replace(/_/g, ' ')} · {selectedUser.businessAccess.replace(/,/g, ', ')}</p>
                  {selectedUser.linked && (
                    <p className="mt-1 text-[11px] text-green-400">Already linked to {selectedUser.linkedEmployeeId}. Duplicate links are blocked.</p>
                  )}
                  {selectedUser.linkState === 'orphan' && (
                    <p className="mt-1 text-[11px] text-red-300">Stale ID on file — clear or re-link before creating a duplicate roster row.</p>
                  )}
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
            </div>
            </div>
            </div>

            <div className="mobile-modal-footer px-5 pt-3">
              <div className="flex gap-2">
                <Button
                  type="submit"
                  variant="gold"
                  disabled={saving || Boolean(selectedUser?.linked)}
                >
                  {saving ? 'Saving…' : selectedUser ? 'Create Employee From User' : 'Save'}
                </Button>
                <Button type="button" variant="ghost" onClick={() => { setOpen(false); setSelectedUserId('') }}>Cancel</Button>
              </div>
            </div>
            </form>
          </Card>
        </MobileModalPortal>
      )}
    </FinancePageChrome>
  )
}
