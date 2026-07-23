'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { PageHeader, Card, Button, Input, Select, KpiCard, Skeleton } from '@/components/ui'
import { BiometricLockToggle } from '@/components/settings/BiometricLockToggle'
import { useActor } from '@/contexts/ActorContext'
import { BUSINESS_LIST } from '@/lib/businesses'
import { ALMA_ROLE_OPTIONS, normalizeAlmaRole } from '@/lib/roles'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } }
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.35 } } }

type Stats = {
  totals: { recipients: number; delivered: number; seen: number; read: number; acknowledged: number; openRate: number; ackRate: number }
  broadcasts: Array<{ id: string; title: string; target: string; priority: string; recipients: number; delivered: number; seen: number; acknowledged: number; createdAt: string }>
}

type UserOption = { id: string; name: string; email: string }
type Preference = {
  enabled: boolean
  highPriorityOnly: boolean
  criticalAlways: boolean
  agentCompletions: boolean
  approvals: boolean
  orders: boolean
  payrollWallet: boolean
  inventory: boolean
  finance: boolean
  announcements: boolean
}
type PreferenceKey = keyof Preference

type PushHealthUser = {
  userId: string
  name: string
  role: string
  devices: Array<{ type: string; enabled: boolean; notificationTypes: number | null; deviceModel: string | null; deviceOs: string | null }>
  enabledCount: number
  nativeEnabled: boolean
  verdict: 'OK' | 'WEB_ONLY' | 'DEAD' | 'NEVER_REGISTERED'
}

const VERDICT_BADGE: Record<PushHealthUser['verdict'], { label: string; className: string }> = {
  OK: { label: 'Push প্রস্তুত', className: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30' },
  WEB_ONLY: { label: 'শুধু browser', className: 'bg-amber-500/15 text-amber-300 border-amber-400/30' },
  DEAD: { label: 'Push বন্ধ', className: 'bg-red-500/15 text-red-300 border-red-400/30' },
  NEVER_REGISTERED: { label: 'Register হয়নি', className: 'bg-red-500/15 text-red-300 border-red-400/30' },
}

const VERDICT_FIX: Record<PushHealthUser['verdict'], string | null> = {
  OK: null,
  WEB_ONLY: 'ALMA ERP app install করে notification Allow করুন।',
  DEAD: 'ফোনের Settings → ALMA ERP → Notifications → Allow করুন।',
  NEVER_REGISTERED: 'এই ডিভাইসে “Enable device notifications” চাপুন।',
}

const CATEGORY_ROWS: Array<{ key: PreferenceKey; title: string; detail: string }> = [
  { key: 'agentCompletions', title: 'Agent কাজ শেষ', detail: 'Background-এ agent-এর কাজ শেষ হলে জানাবে।' },
  { key: 'approvals', title: 'Approval দরকার', detail: 'আপনার অনুমোদন অপেক্ষায় থাকলে জানাবে।' },
  { key: 'orders', title: 'Orders', detail: 'Assigned order এবং order status update।' },
  { key: 'payrollWallet', title: 'Payroll ও Wallet', detail: 'Salary, payroll alert এবং wallet request।' },
  { key: 'inventory', title: 'Inventory', detail: 'Low-stock ও জরুরি inventory alert।' },
  { key: 'finance', title: 'Finance', detail: 'Expense ও invoice-related update।' },
  { key: 'announcements', title: 'Announcements', detail: 'Admin announcement ও সাধারণ update।' },
]

function PreferenceToggle({
  title,
  detail,
  checked,
  disabled,
  saving,
  onChange,
}: {
  title: string
  detail: string
  checked: boolean
  disabled?: boolean
  saving?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className={`flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-3 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold text-cream">{title}</span>
        <span className="mt-0.5 block text-[10px] leading-relaxed text-muted">{detail}</span>
      </span>
      {saving && <span className="text-[9px] text-muted">Saving…</span>}
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.target.checked)}
      />
      <span className="relative h-6 w-11 shrink-0 rounded-full bg-white/10 transition peer-checked:bg-emerald-500/70 peer-focus-visible:ring-2 peer-focus-visible:ring-gold/60 after:absolute after:left-1 after:top-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-5" />
    </label>
  )
}

export default function NotificationSettingsPage() {
  const { role } = useActor()
  const normalizedRole = normalizeAlmaRole(role)
  const isAdmin = normalizedRole === 'SUPER_ADMIN' || normalizedRole === 'ADMIN'

  const [preference, setPreference] = useState<Preference | null>(null)
  const [preferenceLoading, setPreferenceLoading] = useState(true)
  const [savingKey, setSavingKey] = useState<PreferenceKey | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [users, setUsers] = useState<UserOption[]>([])
  const [adminLoading, setAdminLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [health, setHealth] = useState<PushHealthUser[] | null>(null)
  const [healthLoading, setHealthLoading] = useState(false)
  const [form, setForm] = useState({
    title: '',
    message: '',
    priority: 'NORMAL',
    target: 'ALL',
    targetRole: 'STAFF',
    targetBusinessId: 'ALMA_LIFESTYLE',
    targetUserId: '',
    actionUrl: '',
    pinned: false,
  })

  const loadPreferences = useCallback(async () => {
    setPreferenceLoading(true)
    try {
      const res = await fetch('/api/notifications/preferences', { cache: 'no-store' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Notification settings load হয়নি')
      setPreference(json.preference)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Notification settings load হয়নি')
    } finally {
      setPreferenceLoading(false)
    }
  }, [])

  const loadAdmin = useCallback(async () => {
    if (!isAdmin) return
    setAdminLoading(true)
    try {
      const [statsRes, usersRes] = await Promise.all([
        fetch('/api/notifications/stats', { cache: 'no-store' }),
        fetch('/api/users', { cache: 'no-store' }),
      ])
      if (statsRes.ok) setStats(await statsRes.json())
      if (usersRes.ok) {
        const json = await usersRes.json()
        setUsers(json.users ?? [])
      }
    } finally {
      setAdminLoading(false)
    }
  }, [isAdmin])

  const loadHealth = useCallback(async () => {
    setHealthLoading(true)
    try {
      const query = isAdmin ? '?scope=all' : ''
      const res = await fetch(`/api/notifications/push-health${query}`, { cache: 'no-store' })
      if (res.ok) {
        const json = await res.json()
        setHealth(json.users ?? [])
      }
    } finally {
      setHealthLoading(false)
    }
  }, [isAdmin])

  useEffect(() => {
    void loadPreferences()
    void loadAdmin()
    void loadHealth()
  }, [loadPreferences, loadAdmin, loadHealth])

  async function savePreference(key: PreferenceKey, value: boolean) {
    if (!preference || savingKey) return
    const previous = preference
    setPreference({ ...preference, [key]: value })
    setSavingKey(key)
    try {
      const res = await fetch('/api/notifications/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Save হয়নি')
      setPreference(json.preference)
      toast.success('Notification preference saved')
    } catch (err) {
      setPreference(previous)
      toast.error(err instanceof Error ? err.message : 'Save হয়নি')
    } finally {
      setSavingKey(null)
    }
  }

  async function send() {
    if (sending || !isAdmin) return
    setSending(true)
    try {
      const res = await fetch('/api/notifications/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || 'Broadcast পাঠানো যায়নি')
        return
      }
      toast.success(`${json.recipients} জনকে broadcast পাঠানো হয়েছে`)
      setForm(current => ({ ...current, title: '', message: '' }))
      await loadAdmin()
    } finally {
      setSending(false)
    }
  }

  function enableDeviceNotifications() {
    window.dispatchEvent(new Event('alma-enable-push'))
  }

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="আপনার role ও কাজ অনুযায়ী কোন notification পাবেন তা নিয়ন্ত্রণ করুন।"
        actions={
          <Button size="xs" variant="secondary" onClick={() => {
            void loadPreferences()
            void loadHealth()
            void loadAdmin()
          }}>
            Refresh
          </Button>
        }
      />
      <motion.div className="space-y-4 p-4 md:p-6" variants={stagger} initial="hidden" animate="show">
        <motion.div variants={fadeUp}>
          <Card className="p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-cream">My notification controls</p>
                <p className="mt-1 text-[11px] text-muted">
                  Logged in as {normalizedRole.replace(/_/g, ' ')} · Critical alert-এর আলাদা safety control আছে।
                </p>
              </div>
              <Button size="xs" variant="secondary" onClick={enableDeviceNotifications}>
                Enable device notifications
              </Button>
            </div>
            {preferenceLoading || !preference ? <Skeleton className="h-72" /> : (
              <div className="space-y-3">
                <div className="grid gap-2 md:grid-cols-3">
                  <PreferenceToggle
                    title="সব notification"
                    detail="Off করলে critical safety rule ছাড়া সব বন্ধ থাকবে।"
                    checked={preference.enabled}
                    saving={savingKey === 'enabled'}
                    disabled={savingKey != null}
                    onChange={value => void savePreference('enabled', value)}
                  />
                  <PreferenceToggle
                    title="শুধু high priority"
                    detail="Normal ও low update বাদ দিয়ে শুধু High/Critical রাখুন।"
                    checked={preference.highPriorityOnly}
                    saving={savingKey === 'highPriorityOnly'}
                    disabled={savingKey != null || !preference.enabled}
                    onChange={value => void savePreference('highPriorityOnly', value)}
                  />
                  <PreferenceToggle
                    title="Critical সবসময়"
                    detail="Master off থাকলেও জরুরি safety alert আসবে।"
                    checked={preference.criticalAlways}
                    saving={savingKey === 'criticalAlways'}
                    disabled={savingKey != null}
                    onChange={value => void savePreference('criticalAlways', value)}
                  />
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {CATEGORY_ROWS.map(row => (
                    <PreferenceToggle
                      key={row.key}
                      title={row.title}
                      detail={row.detail}
                      checked={preference[row.key]}
                      saving={savingKey === row.key}
                      disabled={savingKey != null || !preference.enabled}
                      onChange={value => void savePreference(row.key, value)}
                    />
                  ))}
                </div>
              </div>
            )}
          </Card>
        </motion.div>

        <motion.div variants={fadeUp}>
          <BiometricLockToggle />
        </motion.div>

        <motion.div variants={fadeUp}>
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-cream">{isAdmin ? 'Team device push health' : 'My device push health'}</p>
                <p className="mt-1 text-[11px] text-muted">OneSignal-এর live delivery state—database registration নয়।</p>
              </div>
              <Button size="xs" variant="secondary" onClick={() => void loadHealth()} disabled={healthLoading}>
                {healthLoading ? 'Checking…' : 'Re-check'}
              </Button>
            </div>
            {healthLoading && !health ? <Skeleton className="h-32" /> : !health?.length ? (
              <p className="text-xs text-muted">এই ডিভাইসের push subscription পাওয়া যায়নি।</p>
            ) : (
              <div className="space-y-2">
                {health.map(user => (
                  <div key={user.userId} className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-cream">{user.name}</span>
                      <span className="text-[10px] uppercase tracking-wide text-muted">{user.role}</span>
                      <span className={`ml-auto rounded-full border px-2 py-0.5 text-[10px] font-bold ${VERDICT_BADGE[user.verdict].className}`}>
                        {VERDICT_BADGE[user.verdict].label}
                      </span>
                    </div>
                    {user.devices.length > 0 && (
                      <p className="mt-1 text-[10px] text-muted">
                        {user.devices.map((device, index) => (
                          <span key={`${device.type}-${index}`} className="mr-2 inline-block">
                            {device.enabled ? '🟢' : '⚫️'} {device.type.replace('Push', '')} {device.deviceModel || ''}
                          </span>
                        ))}
                      </p>
                    )}
                    {VERDICT_FIX[user.verdict] && <p className="mt-1 text-[10px] font-medium text-amber-200/90">{VERDICT_FIX[user.verdict]}</p>}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </motion.div>

        {isAdmin && (
          <>
            <motion.div variants={fadeUp} className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <KpiCard label="Recipients" value={adminLoading ? '—' : stats?.totals.recipients ?? 0} loading={adminLoading} />
              <KpiCard label="Delivered" value={adminLoading ? '—' : stats?.totals.delivered ?? 0} loading={adminLoading} />
              <KpiCard label="Open rate" value={adminLoading ? '—' : `${stats?.totals.openRate ?? 0}%`} loading={adminLoading} />
              <KpiCard label="Ack rate" value={adminLoading ? '—' : `${stats?.totals.ackRate ?? 0}%`} loading={adminLoading} />
            </motion.div>

            <motion.div variants={fadeUp} className="grid gap-4 lg:grid-cols-[420px_1fr]">
              <Card className="space-y-3 p-5">
                <div>
                  <p className="text-sm font-semibold text-cream">Admin broadcast</p>
                  <p className="mt-1 text-[11px] text-muted">Role, business বা নির্দিষ্ট user-কে targeted alert পাঠান।</p>
                </div>
                <Input value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} placeholder="Notification title" />
                <textarea
                  value={form.message}
                  onChange={event => setForm({ ...form, message: event.target.value })}
                  placeholder="Message"
                  rows={5}
                  className="w-full rounded-xl border border-white/[0.08] bg-card/85 px-4 py-3 text-sm text-cream placeholder-slate-400 focus:border-gold-dim/60 focus:outline-none"
                />
                <div className="grid grid-cols-2 gap-2">
                  <Select value={form.priority} onChange={priority => setForm({ ...form, priority })} options={['LOW', 'NORMAL', 'HIGH', 'CRITICAL'].map(value => ({ label: value, value }))} />
                  <Select value={form.target} onChange={target => setForm({ ...form, target })} options={['ALL', 'ROLE', 'BUSINESS', 'USER'].map(value => ({ label: value, value }))} />
                </div>
                {form.target === 'ROLE' && <Select value={form.targetRole} onChange={targetRole => setForm({ ...form, targetRole })} options={ALMA_ROLE_OPTIONS.map(item => ({ label: item.label, value: item.id }))} />}
                {form.target === 'BUSINESS' && <Select value={form.targetBusinessId} onChange={targetBusinessId => setForm({ ...form, targetBusinessId })} options={BUSINESS_LIST.map(business => ({ label: business.name, value: business.id }))} />}
                {form.target === 'USER' && <Select value={form.targetUserId} onChange={targetUserId => setForm({ ...form, targetUserId })} options={[{ label: 'Choose user', value: '' }, ...users.map(user => ({ label: `${user.name} · ${user.email}`, value: user.id }))]} />}
                <Input value={form.actionUrl} onChange={event => setForm({ ...form, actionUrl: event.target.value })} placeholder="Action URL, e.g. /orders" />
                <label className="flex items-center gap-2 text-xs text-muted">
                  <input type="checkbox" checked={form.pinned} onChange={event => setForm({ ...form, pinned: event.target.checked })} />
                  Pin this notification
                </label>
                <Button variant="gold" onClick={() => void send()} disabled={sending || !form.title.trim() || !form.message.trim() || (form.target === 'USER' && !form.targetUserId)}>
                  {sending ? 'Sending…' : 'Send broadcast'}
                </Button>
              </Card>

              <Card className="p-5">
                <p className="mb-4 text-sm font-semibold text-cream">Delivery dashboard</p>
                {adminLoading ? <Skeleton className="h-56" /> : !(stats?.broadcasts ?? []).length ? (
                  <p className="text-xs text-muted">No broadcasts sent yet.</p>
                ) : (
                  <div className="table-scroll">
                    <table className="w-full min-w-[760px] text-left text-[11px]">
                      <thead className="sticky top-0 z-[1] border-b border-white/[0.08] bg-card/90 text-[11px] font-medium uppercase tracking-wider text-muted backdrop-blur-sm">
                        <tr>
                          <th className="py-2 pr-3">Title</th><th className="py-2 pr-3">Target</th><th className="py-2 pr-3">Priority</th>
                          <th className="py-2 pr-3 text-right">Delivered</th><th className="py-2 pr-3 text-right">Seen</th><th className="py-2 pr-3 text-right">Ack</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats!.broadcasts.map(broadcast => (
                          <tr key={broadcast.id} className="border-b border-white/[0.04] transition-colors hover:bg-white/[0.04]">
                            <td className="py-2 pr-3 text-cream">{broadcast.title}<span className="block text-[10px] text-muted">{new Date(broadcast.createdAt).toLocaleString()}</span></td>
                            <td className="py-2 pr-3">{broadcast.target}</td><td className="py-2 pr-3">{broadcast.priority}</td>
                            <td className="py-2 pr-3 text-right font-mono">{broadcast.delivered}/{broadcast.recipients}</td>
                            <td className="py-2 pr-3 text-right font-mono">{broadcast.seen}</td><td className="py-2 pr-3 text-right font-mono">{broadcast.acknowledged}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </motion.div>
          </>
        )}
      </motion.div>
    </>
  )
}
