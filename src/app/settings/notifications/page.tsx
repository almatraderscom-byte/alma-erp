'use client'

import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { PageHeader, Card, Button, Input, Select, KpiCard, Skeleton } from '@/components/ui'
import { BUSINESS_LIST } from '@/lib/businesses'
import { ALMA_ROLE_OPTIONS } from '@/lib/roles'

type Stats = {
  totals: { recipients: number; delivered: number; seen: number; read: number; acknowledged: number; openRate: number; ackRate: number }
  broadcasts: Array<{ id: string; title: string; target: string; priority: string; recipients: number; delivered: number; seen: number; acknowledged: number; createdAt: string }>
}

type UserOption = { id: string; name: string; email: string }

export default function NotificationSettingsPage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [users, setUsers] = useState<UserOption[]>([])
  const [loading, setLoading] = useState(true)
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

  async function load() {
    setLoading(true)
    const [statsRes, usersRes] = await Promise.all([
      fetch('/api/notifications/stats', { cache: 'no-store' }),
      fetch('/api/users', { cache: 'no-store' }),
    ])
    if (statsRes.ok) setStats(await statsRes.json())
    if (usersRes.ok) {
      const json = await usersRes.json()
      setUsers(json.users ?? [])
    }
    setLoading(false)
  }

  useEffect(() => {
    void load()
  }, [])

  async function send() {
    const res = await fetch('/api/notifications/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(json.error || 'Could not send broadcast')
      return
    }
    toast.success(`Broadcast sent to ${json.recipients} recipient(s)`)
    setForm(f => ({ ...f, title: '', message: '' }))
    await load()
  }

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="Broadcasts, push delivery, acknowledgments, and open-rate monitoring."
        actions={<Button size="xs" variant="secondary" onClick={() => void load()}>Refresh</Button>}
      />
      <div className="p-4 md:p-6 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="Recipients" value={loading ? '—' : stats?.totals.recipients ?? 0} loading={loading} />
          <KpiCard label="Delivered" value={loading ? '—' : stats?.totals.delivered ?? 0} loading={loading} />
          <KpiCard label="Open rate" value={loading ? '—' : `${stats?.totals.openRate ?? 0}%`} loading={loading} />
          <KpiCard label="Ack rate" value={loading ? '—' : `${stats?.totals.ackRate ?? 0}%`} loading={loading} />
        </div>

        <div className="grid lg:grid-cols-[420px_1fr] gap-4">
          <Card className="p-5 space-y-3">
            <div>
              <p className="text-sm font-bold text-cream">Admin broadcast</p>
              <p className="text-[11px] text-zinc-500 mt-1">Send persistent in-app notifications and OneSignal push alerts when configured.</p>
            </div>
            <Input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="Notification title" />
            <textarea
              value={form.message}
              onChange={e => setForm({ ...form, message: e.target.value })}
              placeholder="Message"
              rows={5}
              className="w-full rounded-xl bg-card border border-border px-4 py-3 text-sm text-cream placeholder-zinc-600 focus:outline-none focus:border-gold-dim/60"
            />
            <div className="grid grid-cols-2 gap-2">
              <Select value={form.priority} onChange={priority => setForm({ ...form, priority })} options={['LOW', 'NORMAL', 'HIGH', 'CRITICAL'].map(p => ({ label: p, value: p }))} />
              <Select value={form.target} onChange={target => setForm({ ...form, target })} options={['ALL', 'ROLE', 'BUSINESS', 'USER'].map(t => ({ label: t, value: t }))} />
            </div>
            {form.target === 'ROLE' && <Select value={form.targetRole} onChange={targetRole => setForm({ ...form, targetRole })} options={ALMA_ROLE_OPTIONS.map(r => ({ label: r.label, value: r.id }))} />}
            {form.target === 'BUSINESS' && <Select value={form.targetBusinessId} onChange={targetBusinessId => setForm({ ...form, targetBusinessId })} options={BUSINESS_LIST.map(b => ({ label: b.name, value: b.id }))} />}
            {form.target === 'USER' && <Select value={form.targetUserId} onChange={targetUserId => setForm({ ...form, targetUserId })} options={[{ label: 'Choose user', value: '' }, ...users.map(u => ({ label: `${u.name} · ${u.email}`, value: u.id }))]} />}
            <Input value={form.actionUrl} onChange={e => setForm({ ...form, actionUrl: e.target.value })} placeholder="Action URL, e.g. /payroll" />
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input type="checkbox" checked={form.pinned} onChange={e => setForm({ ...form, pinned: e.target.checked })} />
              Pin this notification
            </label>
            <Button variant="gold" onClick={() => void send()} disabled={!form.title.trim() || !form.message.trim() || (form.target === 'USER' && !form.targetUserId)}>
              Send broadcast
            </Button>
          </Card>

          <Card className="p-5">
            <p className="text-sm font-bold text-cream mb-4">Delivery dashboard</p>
            {loading ? <Skeleton className="h-56" /> : !(stats?.broadcasts ?? []).length ? (
              <p className="text-xs text-zinc-600">No broadcasts sent yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[11px]">
                  <thead className="text-zinc-500 border-b border-border">
                    <tr>
                      <th className="py-2 pr-3">Title</th>
                      <th className="py-2 pr-3">Target</th>
                      <th className="py-2 pr-3">Priority</th>
                      <th className="py-2 pr-3 text-right">Delivered</th>
                      <th className="py-2 pr-3 text-right">Seen</th>
                      <th className="py-2 pr-3 text-right">Ack</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats!.broadcasts.map(b => (
                      <tr key={b.id} className="border-b border-border/50">
                        <td className="py-2 pr-3 text-cream">{b.title}<span className="block text-[10px] text-zinc-600">{new Date(b.createdAt).toLocaleString()}</span></td>
                        <td className="py-2 pr-3">{b.target}</td>
                        <td className="py-2 pr-3">{b.priority}</td>
                        <td className="py-2 pr-3 text-right font-mono">{b.delivered}/{b.recipients}</td>
                        <td className="py-2 pr-3 text-right font-mono">{b.seen}</td>
                        <td className="py-2 pr-3 text-right font-mono">{b.acknowledged}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  )
}
