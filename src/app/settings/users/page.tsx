'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { Button, Card, Empty, Skeleton } from '@/components/ui'
import { ALMA_ROLE_OPTIONS, can, normalizeAlmaRole, type AlmaRole } from '@/lib/roles'
import { BUSINESS_LIST, type BusinessId } from '@/lib/businesses'
import { useActor } from '@/contexts/ActorContext'
import type { UserRole } from '@prisma/client'
import toast from 'react-hot-toast'
import { displayBdPhone } from '@/lib/phone'
import { EmployeeAvatar } from '@/components/profile/EmployeeAvatar'
import { ProfilePhotoUploader } from '@/components/profile/ProfilePhotoUploader'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import { motion } from 'framer-motion'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } }
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.35 } } }

type RowUser = {
  id: string
  email: string | null
  name: string
  phone: string | null
  role: UserRole
  active: boolean
  businessAccess: string
  employeeIdGas: string | null
  joiningDate: string | null
  salaryHint: string | null
  profileImageUrl: string | null
  createdAt: string
}

function RoleBadge({ role }: { role: UserRole }) {
  const tone =
    role === 'SUPER_ADMIN'
      ? 'bg-purple-50 text-purple-600 border-purple-200'
      : role === 'ADMIN'
        ? 'bg-gold/10 text-gold-dim border-gold/30'
        : role === 'HR'
          ? 'bg-sky-50 text-sky-600 border-sky-200'
          : role === 'STAFF'
            ? 'bg-slate-100 text-slate-600 border-slate-200'
            : 'bg-emerald-50 text-emerald-600 border-emerald-200'
  return (
    <span className={`inline-flex text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${tone}`}>
      {role.replace(/_/g, ' ')}
    </span>
  )
}

function parseBizCsv(csv: string): BusinessId[] {
  const ids = csv.split(',').map(s => s.trim()).filter(Boolean) as BusinessId[]
  return ids.filter(id => id === 'ALMA_LIFESTYLE' || id === 'CREATIVE_DIGITAL_IT')
}

export default function UsersSettingsPage() {
  const { role: actorRole } = useActor()
  const normalized = normalizeAlmaRole(actorRole)

  const [users, setUsers] = useState<RowUser[]>([])
  const [loading, setLoading] = useState(true)

  const [createOpen, setCreateOpen] = useState(false)
  const [editUser, setEditUser] = useState<RowUser | null>(null)
  const [permUser, setPermUser] = useState<RowUser | null>(null)
  const [resetUser, setResetUser] = useState<RowUser | null>(null)

  const allowed = useMemo(() => can(normalized, 'userManage'), [normalized])

  const load = useCallback(async (options?: { showLoading?: boolean }) => {
    const showLoading = options?.showLoading ?? true
    if (showLoading) setLoading(true)
    try {
      const res = await fetch('/api/users', { cache: 'no-store' })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || res.statusText)
      }
      const j = (await res.json()) as { users: RowUser[] }
      setUsers(j.users)
    } catch (e) {
      toast.error((e as Error).message || 'Could not load users')
      if (showLoading) setUsers([])
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!allowed) return
    void load()
  }, [allowed, load])

  const roleOptionsForActor = useMemo(() => {
    if (normalized === 'SUPER_ADMIN') return ALMA_ROLE_OPTIONS
    return ALMA_ROLE_OPTIONS.filter(o => o.id !== 'SUPER_ADMIN')
  }, [normalized])

  async function patchUser(id: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || res.statusText)
    toast.success('Saved')
    await load()
  }

  if (!allowed) {
    return (
      <FinancePageChrome title="Users" subtitle="Employee accounts · roles · access">
        <Card className="p-8">
          <Empty icon="◫" title="Restricted" desc="Only administrators can manage ERP accounts." />
        </Card>
      </FinancePageChrome>
    )
  }

  return (
    <>
      <FinancePageChrome
        title="Users"
        subtitle="Accounts · roles · business scope · HR linkage"
        actions={<Button size="xs" variant="gold" onClick={() => setCreateOpen(true)}>+ Add user</Button>}
      >
        <motion.div variants={stagger} initial="hidden" animate="show" className="min-w-0 max-w-full space-y-4">
        <motion.div variants={fadeUp}>
        <Card className="min-w-0 bg-white">
          <div className="p-4 border-b border-black/[0.04] flex justify-between items-center gap-3 flex-wrap">
            <p className="text-xs text-slate-500">{users.length} accounts · bcrypt-hashed passwords · JWT sessions</p>
            <Button size="xs" variant="secondary" type="button" onClick={() => void load()}>Refresh</Button>
          </div>
          {loading ? (
            <Skeleton className="h-72 m-4" />
          ) : users.length === 0 ? (
            <Empty icon="◎" title="No users" desc="Seed the database or create the first employee login." />
          ) : (
            <div className="overflow-x-auto min-w-0 max-w-full table-scroll max-h-[72vh]">
              <table className="w-full min-w-[980px] text-left text-[11px]">
                <thead className="sticky top-0 bg-white border-b border-black/[0.04] text-[11px] font-medium uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="py-2 px-4">Name</th>
                    <th className="py-2 pr-3">Phone</th>
                    <th className="py-2 pr-3">Email</th>
                    <th className="py-2 pr-3">Role</th>
                    <th className="py-2 pr-3">Business</th>
                    <th className="py-2 pr-3">HR ID</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map(u => (
                    <tr key={u.id} className="border-b border-black/[0.04] hover:bg-slate-50/50 transition-colors">
                      <td className="py-2 px-4">
                        <div className="flex items-center gap-2">
                          <EmployeeAvatar userId={u.id} name={u.name} email={u.email} imageUrl={u.profileImageUrl} size="sm" />
                          <span className="text-slate-800 font-medium">{u.name}</span>
                        </div>
                      </td>
                      <td className="py-2 pr-3 font-mono text-gold-lt">{u.phone ? displayBdPhone(u.phone) : '—'}</td>
                      <td className="py-2 pr-3 font-mono text-slate-500">{u.email || '—'}</td>
                      <td className="py-2 pr-3"><RoleBadge role={u.role} /></td>
                      <td className="py-2 pr-3 text-slate-500 max-w-[140px] truncate" title={u.businessAccess}>{u.businessAccess.replace(/,/g, ', ')}</td>
                      <td className="py-2 pr-3 font-mono text-gold-dim">{u.employeeIdGas || '—'}</td>
                      <td className="py-2 pr-3">
                        <span className={u.active ? 'text-green-400' : 'text-red-400'}>{u.active ? 'Active' : 'Inactive'}</span>
                      </td>
                      <td className="py-2 pr-4 text-right space-x-2 whitespace-nowrap">
                        <button type="button" className="text-gold hover:underline" onClick={() => setPermUser(u)}>Permissions</button>
                        <button type="button" className="text-gold-dim hover:underline" onClick={() => setEditUser(u)}>Edit</button>
                        <button type="button" className="text-slate-500 hover:underline" onClick={() => setResetUser(u)}>Reset PW</button>
                        <button
                          type="button"
                          className="text-slate-500 hover:text-amber-400"
                          onClick={() => void patchUser(u.id, { active: !u.active })}
                        >
                          {u.active ? 'Deactivate' : 'Activate'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        </motion.div>
        </motion.div>
      </FinancePageChrome>

      {permUser && (
        <div className="fixed inset-0 z-[140] bg-black/75 backdrop-blur-sm flex items-end md:items-center justify-center p-4">
          <Card className="w-full max-w-md p-6 border-gold-dim/30 space-y-4">
            <div className="flex justify-between gap-3 items-start">
              <div>
                <p className="text-sm font-bold text-slate-800">Role capabilities</p>
                <p className="text-[11px] text-slate-500 mt-1">{permUser.name} · server-enforced ERP scope</p>
              </div>
              <button type="button" className="text-slate-500 hover:text-slate-800 text-lg leading-none" onClick={() => setPermUser(null)}>×</button>
            </div>
            <RoleBadge role={permUser.role} />
            <p className="text-[11px] text-slate-500">Business access: <span className="font-mono text-slate-400">{permUser.businessAccess}</span></p>
            <p className="text-xs text-slate-600 leading-relaxed">
              {ALMA_ROLE_OPTIONS.find(o => o.id === permUser.role)?.hint}
            </p>
            <Button variant="secondary" className="w-full justify-center" type="button" onClick={() => setPermUser(null)}>Close</Button>
          </Card>
        </div>
      )}

      {resetUser && (
        <ResetPasswordModal
          user={resetUser}
          onClose={() => setResetUser(null)}
          onDone={() => { setResetUser(null); void load() }}
        />
      )}

      {editUser && (
        <UserFormModal
          title="Edit account"
          actorRole={normalized}
          roleOptions={roleOptionsForActor}
          initial={editUser}
          onClose={() => setEditUser(null)}
          onSubmit={async fd => {
            const bizIds = BUSINESS_LIST.filter(b => fd.get(`biz_${b.id}`) === 'on').map(b => b.id)
            if (!bizIds.length) {
              toast.error('Select at least one business')
              return
            }
            await patchUser(editUser.id, {
              name: String(fd.get('name') || '').trim(),
              phone: String(fd.get('phone') || '').trim() || null,
              email: String(fd.get('email') || '').trim().toLowerCase() || null,
              role: String(fd.get('role') || '') as UserRole,
              businessAccess: bizIds.join(','),
              employeeIdGas: String(fd.get('employeeIdGas') || '').trim() || null,
              joiningDate: String(fd.get('joining_date') || '').trim() || null,
              salaryHint: fd.get('salary_hint') ? Number(fd.get('salary_hint')) : null,
            })
            setEditUser(null)
          }}
        />
      )}

      {createOpen && (
        <UserFormModal
          title="Create account"
          actorRole={normalized}
          roleOptions={roleOptionsForActor}
          initial={null}
          onClose={() => setCreateOpen(false)}
          onSubmit={async fd => {
            const bizIds = BUSINESS_LIST.filter(b => fd.get(`biz_${b.id}`) === 'on').map(b => b.id)
            if (!bizIds.length) {
              toast.error('Select at least one business')
              return
            }
            const email = String(fd.get('email') || '').trim().toLowerCase()
            const password = String(fd.get('password') || '')
            const name = String(fd.get('name') || '').trim()
            const res = await fetch('/api/users', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                email,
                password,
                name,
                phone: String(fd.get('phone') || '').trim(),
                role: String(fd.get('role') || 'STAFF') as UserRole,
                businessAccess: bizIds.join(','),
                employeeIdGas: String(fd.get('employeeIdGas') || '').trim() || undefined,
                active: true,
                joiningDate: String(fd.get('joining_date') || '').trim() || null,
                salaryHint: fd.get('salary_hint') ? Number(fd.get('salary_hint')) : null,
              }),
            })
            const j = await res.json().catch(() => ({})) as { error?: string; user?: RowUser }
            if (!res.ok) {
              toast.error(j.error || 'Create failed')
              return
            }
            await load({ showLoading: false })
            setCreateOpen(false)
            toast.success('User created')
          }}
        />
      )}
    </>
  )
}

function ResetPasswordModal({
  user,
  onClose,
  onDone,
}: {
  user: RowUser
  onClose: () => void
  onDone: () => void
}) {
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const password = String(fd.get('password') || '')
    if (password.length < 8) {
      toast.error('Password must be at least 8 characters')
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/users/${user.id}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(j.error || 'Failed')
        return
      }
      toast.success('Password updated')
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <MobileModalPortal open zIndex={140} onBackdropClick={onClose}>
      <Card className="mobile-modal-shell w-full max-w-md border-gold-dim/30 sm:rounded-2xl">
        <div className="mobile-modal-header p-6 pb-3">
          <div className="flex justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-slate-800">Reset password</p>
              <p className="text-[11px] text-slate-500 mt-1">{user.email}</p>
            </div>
            <button type="button" className="text-slate-500 hover:text-slate-800" onClick={onClose}>×</button>
          </div>
        </div>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="mobile-modal-body px-6">
            <label className="block space-y-1 text-xs">
              <span className="text-slate-500">New password</span>
              <input name="password" type="password" autoComplete="new-password" required minLength={8} className="w-full bg-white border border-black/[0.08] rounded-xl px-3 py-2 text-slate-800 text-sm focus:outline-none focus:border-gold/50" />
            </label>
          </div>
          <div className="mobile-modal-footer px-6 pt-3">
            <div className="flex gap-2">
              <Button variant="secondary" type="button" className="flex-1 justify-center" onClick={onClose}>Cancel</Button>
              <Button variant="gold" type="submit" className="flex-1 justify-center" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
            </div>
          </div>
        </form>
      </Card>
    </MobileModalPortal>
  )
}

function UserFormModal({
  title,
  actorRole,
  roleOptions,
  initial,
  onClose,
  onSubmit,
}: {
  title: string
  actorRole: AlmaRole
  roleOptions: typeof ALMA_ROLE_OPTIONS
  initial: RowUser | null
  onClose: () => void
  onSubmit: (fd: FormData) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [selectedRole, setSelectedRole] = useState<UserRole>(initial?.role || 'STAFF')
  const selectedBiz = initial ? parseBizCsv(initial.businessAccess) : (['ALMA_LIFESTYLE', 'CREATIVE_DIGITAL_IT', 'ALMA_TRADING'] as BusinessId[])
  const systemOwnerAccount = selectedRole === 'SUPER_ADMIN'

  async function wrapped(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    try {
      await onSubmit(new FormData(e.currentTarget))
    } finally {
      setBusy(false)
    }
  }

  return (
    <MobileModalPortal open zIndex={140} onBackdropClick={onClose}>
      <Card className="mobile-modal-shell w-full max-w-lg border-gold-dim/30 sm:rounded-2xl">
        <div className="mobile-modal-header p-5 pb-3">
          <div className="flex justify-between gap-3">
            <p className="text-sm font-bold text-slate-800">{title}</p>
            <button type="button" className="text-slate-500 hover:text-slate-800" onClick={onClose}>×</button>
          </div>
        </div>
        <form onSubmit={wrapped} className="flex min-h-0 flex-1 flex-col text-xs">
          <div className="mobile-modal-body space-y-3 px-5 pb-4">
          {!initial && (
            <>
              <label className="block space-y-1">
                <span className="text-slate-500">Email (optional)</span>
                <input name="email" type="email" className="w-full bg-white border border-black/[0.08] rounded-xl px-3 py-2 text-slate-800 text-sm focus:outline-none focus:border-gold/50" />
              </label>
              <label className="block space-y-1">
                <span className="text-slate-500">Initial password</span>
                <input name="password" type="password" autoComplete="new-password" required minLength={8} className="w-full bg-white border border-black/[0.08] rounded-xl px-3 py-2 text-slate-800 text-sm focus:outline-none focus:border-gold/50" />
              </label>
            </>
          )}
          <label className="block space-y-1">
            <span className="text-slate-500">Full name</span>
            <input name="name" required defaultValue={initial?.name || ''} className="w-full bg-white border border-black/[0.08] rounded-xl px-3 py-2 text-slate-800 text-sm focus:outline-none focus:border-gold/50" />
          </label>
          {initial && (
            <label className="block space-y-1">
              <span className="text-slate-500">Email (optional)</span>
              <input name="email" type="email" defaultValue={initial.email || ''} className="w-full bg-white border border-black/[0.08] rounded-xl px-3 py-2 text-slate-800 text-sm focus:outline-none focus:border-gold/50" />
            </label>
          )}
          <label className="block space-y-1">
            <span className="text-slate-500">Phone (Bangladesh)</span>
            <input name="phone" required={!initial} inputMode="tel" autoComplete="tel" placeholder="+8801XXXXXXXXX" defaultValue={initial?.phone || ''} className="w-full bg-white border border-black/[0.08] rounded-xl px-3 py-2 text-slate-800 text-sm focus:outline-none focus:border-gold/50" />
          </label>
          <label className="block space-y-1">
            <span className="text-slate-500">Role</span>
            <select name="role" required value={selectedRole} onChange={e => setSelectedRole(e.target.value as UserRole)} className="w-full bg-white border border-black/[0.08] rounded-xl px-3 py-2 text-slate-800 text-sm focus:outline-none focus:border-gold/50">
              {roleOptions.map(o => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </label>
          {systemOwnerAccount && (
            <p className="rounded-xl border border-gold-dim/30 bg-gold/10 p-3 text-[11px] leading-relaxed text-gold-lt">
              System owner accounts control the ERP and are not linked to HR employee IDs, salary hints, attendance, or personal wallets.
            </p>
          )}
          <div className="space-y-2 rounded-xl border border-black/[0.08] p-3 bg-slate-50/50">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Business access</p>
            {BUSINESS_LIST.map(b => (
              <label key={b.id} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  name={`biz_${b.id}`}
                  defaultChecked={selectedBiz.includes(b.id)}
                  className="rounded border-black/[0.08]"
                />
                <span className="text-slate-800">{b.name}</span>
              </label>
            ))}
          </div>
          {!systemOwnerAccount && (
            <>
              <label className="block space-y-1">
                <span className="text-slate-500">Linked HR employee ID (GAS)</span>
                <input name="employeeIdGas" defaultValue={initial?.employeeIdGas || ''} placeholder="e.g. EMP-1024" className="w-full bg-white border border-black/[0.08] rounded-xl px-3 py-2 text-slate-800 font-mono text-[11px] focus:outline-none focus:border-gold/50" />
              </label>
              <label className="block space-y-1">
                <span className="text-slate-500">Joining date</span>
                <input name="joining_date" type="date" defaultValue={initial?.joiningDate?.slice(0, 10) || ''} className="w-full bg-white border border-black/[0.08] rounded-xl px-3 py-2 text-slate-800 text-sm focus:outline-none focus:border-gold/50" />
              </label>
              <label className="block space-y-1">
                <span className="text-slate-500">Salary hint (৳)</span>
                <input name="salary_hint" type="number" step="0.01" defaultValue={initial?.salaryHint ? Number(initial.salaryHint) : ''} className="w-full bg-white border border-black/[0.08] rounded-xl px-3 py-2 text-slate-800 font-mono text-sm focus:outline-none focus:border-gold/50" />
              </label>
            </>
          )}
          {initial && (
            <div className="rounded-xl border border-black/[0.08] bg-slate-50/50 p-4">
              <p className="mb-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">Profile photo</p>
              <ProfilePhotoUploader
                userId={initial.id}
                name={initial.name}
                email={initial.email}
                imageUrl={initial.profileImageUrl}
                uploadPath={`/api/users/${initial.id}/profile-image`}
                canEdit
                size="lg"
              />
            </div>
          )}
          {actorRole !== 'SUPER_ADMIN' && (
            <p className="text-[10px] text-amber-400/90 leading-snug">You cannot assign Super Admin.</p>
          )}
          </div>
          <div className="mobile-modal-footer px-5 pt-3">
            <div className="flex gap-2">
              <Button variant="secondary" type="button" className="flex-1 justify-center" onClick={onClose}>Cancel</Button>
              <Button variant="gold" type="submit" className="flex-1 justify-center" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
            </div>
          </div>
        </form>
      </Card>
    </MobileModalPortal>
  )
}
