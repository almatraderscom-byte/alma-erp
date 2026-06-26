'use client'
import Link from 'next/link'
import { motion } from 'framer-motion'
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
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } }
const fadeUp = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: [0.22, 1, 0.36, 1] } } }
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
  const [searchQuery, setSearchQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('ALL')

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

  const rosterEmployees = data?.employees ?? []

  const uniqueRoles = useMemo(() => {
    const roles = new Set(rosterEmployees.map(e => e.role).filter(Boolean))
    return Array.from(roles).sort()
  }, [rosterEmployees])

  const filteredEmployees = useMemo(() => {
    return rosterEmployees.filter(em => {
      const needle = searchQuery.toLowerCase().trim()
      const matchesSearch = !needle ||
        em.name.toLowerCase().includes(needle) ||
        em.emp_id.toLowerCase().includes(needle) ||
        (em.phone && em.phone.includes(needle))
      const matchesRole = roleFilter === 'ALL' || em.role === roleFilter
      return matchesSearch && matchesRole
    })
  }, [rosterEmployees, searchQuery, roleFilter])

  const stats = useMemo(() => ({
    total: rosterEmployees.length,
    active: rosterEmployees.filter(e => e.status === 'Active').length,
    departments: new Set(rosterEmployees.map(e => e.role).filter(Boolean)).size,
  }), [rosterEmployees])

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
    const formEl = e.currentTarget // capture before any await — React nulls currentTarget afterwards
    const fd = new FormData(formEl)
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
      formEl.reset()
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

  function getInitials(name: string) {
    return name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()
  }

  function getStatusColor(status: string) {
    if (status === 'Active') return 'bg-emerald-50 text-emerald-700 border-emerald-200'
    if (status === 'Inactive') return 'bg-red-50 text-red-600 border-red-200'
    return 'bg-amber-50 text-amber-700 border-amber-200'
  }

  return (
    <FinancePageChrome
      title="Employees"
      subtitle="HR registry · salaries · status"
      actions={<Button size="xs" variant="gold" onClick={() => setOpen(true)}>+ Add employee</Button>}
    >
      <div className="min-w-0 max-w-full space-y-5">
        {/* Stats Strip */}
        {!loading && (
          <motion.div
            className="grid grid-cols-3 gap-3"
            variants={stagger}
            initial="hidden"
            animate="show"
          >
            <motion.div variants={fadeUp}>
              <Card className="p-4 text-center">
                <p className="text-2xl font-bold text-cream">{stats.total}</p>
                <p className="text-xs text-muted mt-1">Total Employees</p>
              </Card>
            </motion.div>
            <motion.div variants={fadeUp}>
              <Card className="p-4 text-center">
                <p className="text-2xl font-bold text-emerald-600">{stats.active}</p>
                <p className="text-xs text-muted mt-1">Active</p>
              </Card>
            </motion.div>
            <motion.div variants={fadeUp}>
              <Card className="p-4 text-center">
                <p className="text-2xl font-bold text-[#E07A5F]">{stats.departments}</p>
                <p className="text-xs text-muted mt-1">Roles</p>
              </Card>
            </motion.div>
          </motion.div>
        )}

        {/* Search & Filter Bar */}
        <Card className="p-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search by name, ID, or phone..."
                className="w-full rounded-xl border border-white/[0.06] bg-card/85 pl-10 pr-4 py-2.5 text-sm text-cream placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20 focus:border-[#E07A5F]/40 transition-all"
              />
            </div>
            <select
              value={roleFilter}
              onChange={e => setRoleFilter(e.target.value)}
              className="rounded-xl border border-white/[0.06] bg-card/85 px-4 py-2.5 text-sm text-cream focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20 focus:border-[#E07A5F]/40 transition-all"
            >
              <option value="ALL">All roles</option>
              {uniqueRoles.map(role => (
                <option key={role} value={role}>{role}</option>
              ))}
            </select>
          </div>
          <p className="text-xs text-muted mt-3">{filteredEmployees.length} of {rosterEmployees.length} employees shown</p>
        </Card>

        {/* Employee List */}
        {loading ? <Skeleton className="h-64" /> : !rosterEmployees.length ? (
          <Empty icon="◎" title="No employees yet" desc="Create your roster to unlock payroll tooling" />
        ) : (
          <>
            {/* Mobile: Card Grid */}
            <motion.div
              className="grid grid-cols-2 gap-3 md:hidden"
              variants={stagger}
              initial="hidden"
              animate="show"
            >
              {filteredEmployees.map(em => {
                const linkedUser = usersByEmployeeId.get(em.emp_id)
                return (
                  <motion.div key={em.emp_id} variants={fadeUp}>
                    <Link href={`/employees/${encodeURIComponent(em.emp_id)}`}>
                      <Card interactive className="p-4 h-full flex flex-col items-center text-center hover:shadow-md transition-shadow">
                        <div className="w-12 h-12 rounded-full bg-gradient-to-br from-[#E07A5F]/20 to-[#E07A5F]/5 border border-[#E07A5F]/20 flex items-center justify-center mb-3">
                          <span className="text-sm font-bold text-[#E07A5F]">{getInitials(em.name)}</span>
                        </div>
                        <p className="text-sm font-semibold text-cream truncate w-full">{em.name}</p>
                        <span className="inline-block mt-1.5 text-[10px] font-medium px-2 py-0.5 rounded-full bg-white/[0.06] text-muted-hi">{em.role || 'Staff'}</span>
                        {em.phone && (
                          <p className="text-[11px] text-muted mt-2 font-mono">{displayBdPhone(em.phone)}</p>
                        )}
                        <span className={`mt-2 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${getStatusColor(em.status)}`}>
                          {em.status}
                        </span>
                        {linkedUser && (
                          <span className="mt-1.5 text-[10px] text-emerald-600 font-medium">Linked</span>
                        )}
                      </Card>
                    </Link>
                  </motion.div>
                )
              })}
            </motion.div>

            {/* Desktop: Clean Table */}
            <Card className="hidden md:block overflow-hidden">
              <div className="overflow-x-auto max-h-[70vh]">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-card/88 backdrop-blur-sm border-b border-white/[0.06]">
                    <tr className="text-xs text-muted uppercase tracking-wider">
                      <th className="py-3 px-5 font-medium">Employee</th>
                      <th className="py-3 pr-4 font-medium">Role</th>
                      <th className="py-3 pr-4 font-medium">Salary</th>
                      <th className="py-3 pr-4 font-medium">Status</th>
                      <th className="py-3 pr-4 font-medium">Account</th>
                      <th className="py-3 pr-5 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {filteredEmployees.map(em => {
                      const linkedUser = usersByEmployeeId.get(em.emp_id)
                      return (
                        <tr key={em.emp_id} className="hover:bg-white/[0.04]/80 transition-colors group">
                          <td className="py-3.5 px-5">
                            <div className="flex items-center gap-3">
                              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#E07A5F]/15 to-[#E07A5F]/5 border border-[#E07A5F]/15 flex items-center justify-center shrink-0">
                                <span className="text-xs font-bold text-[#E07A5F]">{getInitials(em.name)}</span>
                              </div>
                              <div className="min-w-0">
                                <p className="font-medium text-cream truncate">{em.name}</p>
                                <p className="text-xs text-muted font-mono">{em.emp_id}</p>
                              </div>
                            </div>
                          </td>
                          <td className="py-3.5 pr-4">
                            <span className="inline-block text-xs font-medium px-2.5 py-1 rounded-lg bg-white/[0.06] text-muted-hi">{em.role || '—'}</span>
                          </td>
                          <td className="py-3.5 pr-4 font-mono text-cream">৳ {em.monthly_salary.toLocaleString('en-BD')}</td>
                          <td className="py-3.5 pr-4">
                            <span className={`inline-block text-xs font-semibold px-2.5 py-1 rounded-full border ${getStatusColor(em.status)}`}>
                              {em.status}
                            </span>
                          </td>
                          <td className="py-3.5 pr-4">
                            {linkedUser ? (
                              <span className="text-xs text-emerald-600 font-medium flex items-center gap-1">
                                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>
                                {linkedUser.name}
                              </span>
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
                                Link account
                              </Button>
                            )}
                          </td>
                          <td className="py-3.5 pr-5">
                            <Link
                              href={`/employees/${encodeURIComponent(em.emp_id)}`}
                              className="text-[#E07A5F] hover:text-[#c56a52] text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              View details →
                            </Link>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>

      {linkRosterEmpId && (
        <MobileModalPortal open zIndex={110} onBackdropClick={() => setLinkRosterEmpId(null)}>
          <Card className="mobile-modal-shell w-full max-w-md border-[#E07A5F]/20 p-5">
            <p className="text-sm font-bold text-cream">Link roster row to user</p>
            <p className="text-[11px] text-muted mt-1 font-mono">{linkRosterEmpId}</p>
            <label className="block mt-4 text-[11px] text-muted">
              User without employee link
              <select
                value={linkUserId}
                onChange={e => setLinkUserId(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2.5 text-cream text-sm"
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
          <Card className="mobile-modal-shell w-full max-w-5xl border-[#E07A5F]/20 sm:rounded-2xl">
            <div className="mobile-modal-header p-5 pb-3">
              <div className="flex justify-between gap-3 items-start">
                <div>
                  <p className="text-sm font-bold text-cream">Employee profile</p>
                  <p className="text-[11px] text-muted mt-1">Create a roster profile manually or directly from an unlinked system user.</p>
                </div>
                <Button type="button" size="xs" variant="secondary" onClick={() => void loadUsers()} disabled={usersLoading}>Refresh users</Button>
              </div>
            </div>

            <form id="employee-create-form" onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <div className="mobile-modal-body px-5 pb-4">
            <div className="grid lg:grid-cols-[1.05fr_1fr] gap-4">
              <div className="rounded-2xl border border-white/[0.06] bg-white/[0.04]/50 p-4">
                <p className="text-[10px] font-black uppercase tracking-[0.14em] text-[#E07A5F] mb-3">Create Employee From User</p>
                {usersLoading ? (
                  <Skeleton className="h-40 w-full" />
                ) : !users.length ? (
                  <p className="text-[11px] text-muted">No users available in this business scope.</p>
                ) : (
                  <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                    {users.map(user => (
                      <div
                        key={user.id}
                        className={`rounded-xl border p-3 transition-all ${selectedUserId === user.id ? 'border-[#E07A5F]/40 bg-[#E07A5F]/5 shadow-sm' : user.selectable ? 'border-white/[0.06] bg-card/85 hover:border-white/[0.12]' : 'border-white/[0.04] bg-white/[0.04] opacity-70'}`}
                      >
                        <button
                          type="button"
                          onClick={() => user.selectable && fillFromUser(user)}
                          disabled={!user.selectable}
                          className="w-full text-left"
                        >
                          <div className="flex justify-between gap-2 items-start">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-cream truncate">{user.name}</p>
                              <p className="text-[10px] text-muted font-mono truncate">{user.email || user.phone || 'No contact'}</p>
                            </div>
                            <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold shrink-0 ${
                              user.linkState === 'linked'
                                ? 'border-emerald-200 text-emerald-700 bg-emerald-50'
                                : user.linkState === 'orphan'
                                  ? 'border-red-200 text-red-600 bg-red-50'
                                  : 'border-amber-200 text-amber-700 bg-amber-50'
                            }`}>
                              {user.linkState === 'linked'
                                ? `Linked ${user.linkedEmployeeId}`
                                : user.linkState === 'orphan'
                                  ? 'Stale ID'
                                  : 'Unlinked'}
                            </span>
                          </div>
                          <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-muted">
                            <span>{user.role.replace(/_/g, ' ')}</span>
                            <span className="font-mono">{user.phone ? displayBdPhone(user.phone) : 'No phone'}</span>
                            <span className="truncate" title={user.businessAccess}>{user.businessAccess.replace(/,/g, ', ')}</span>
                          </div>
                          {user.matchedEmployeeId && user.linkState === 'unlinked' && (
                            <p className="mt-2 text-[10px] text-amber-600">Possible existing employee: {user.matchedEmployeeName} · {user.matchedEmployeeId}</p>
                          )}
                        </button>
                        {user.linkState === 'orphan' && user.orphanEmployeeId && (
                          <div className="mt-3 pt-3 border-t border-white/[0.06] space-y-2">
                            <p className="text-[10px] text-red-600">
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
                                className="flex-1 rounded-lg border border-white/[0.06] bg-card/85 px-2 py-1.5 text-[10px] text-cream"
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
                <div className="rounded-2xl border border-[#E07A5F]/20 bg-[#E07A5F]/[0.03] p-3">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[#E07A5F]">Selected user</p>
                  <p className="mt-1 text-sm font-bold text-cream">{selectedUser.name}</p>
                  <p className="text-[11px] text-muted">{selectedUser.role.replace(/_/g, ' ')} · {selectedUser.businessAccess.replace(/,/g, ', ')}</p>
                  {selectedUser.linked && (
                    <p className="mt-1 text-[11px] text-emerald-600">Already linked to {selectedUser.linkedEmployeeId}. Duplicate links are blocked.</p>
                  )}
                  {selectedUser.linkState === 'orphan' && (
                    <p className="mt-1 text-[11px] text-red-600">Stale ID on file — clear or re-link before creating a duplicate roster row.</p>
                  )}
                </div>
              )}
              <label className="block space-y-1">
                <span className="text-muted">Existing ID (optional)</span>
                <input name="emp_id" className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 text-cream font-mono text-[11px] placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20" placeholder="AUTO if empty" />
              </label>
              <label className="block space-y-1">
                <span className="text-muted">Full name</span>
                <input name="name" required className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 text-cream text-sm focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className="text-muted">Phone</span>
                  <input name="phone" className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 text-cream font-mono text-sm focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20" />
                </label>
                <label className="block space-y-1">
                  <span className="text-muted">Email</span>
                  <input name="email" type="email" className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 text-cream text-sm focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20" />
                </label>
              </div>
              <label className="block space-y-1">
                <span className="text-muted">Address</span>
                <textarea name="address" rows={2} className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 text-cream text-sm focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className="text-muted">Role</span>
                  <input name="role" className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 text-cream text-sm focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20" />
                </label>
                <label className="block space-y-1">
                  <span className="text-muted">Joining date</span>
                  <input name="joining_date" type="date" className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 text-cream font-mono text-sm focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20" />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className="text-muted">Monthly salary</span>
                  <input name="monthly_salary" type="number" step="0.01" className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20" />
                </label>
                <label className="block space-y-1">
                  <span className="text-muted">Status</span>
                  <select name="status" className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 text-sm text-cream focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20">
                    <option>Active</option>
                    <option>Inactive</option>
                    <option>Probation</option>
                  </select>
                </label>
              </div>
              <label className="block space-y-1">
                <span className="text-muted">Notes</span>
                <textarea name="notes" rows={3} className="w-full rounded-xl bg-card/85 border border-white/[0.06] px-3 py-2.5 text-cream text-sm focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20" />
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
