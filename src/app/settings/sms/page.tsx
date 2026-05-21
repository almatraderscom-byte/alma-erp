'use client'

import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { BUSINESS_LIST, type BusinessId } from '@/lib/businesses'
import { Button, Card, Input, KpiCard, PageHeader, Select, Skeleton } from '@/components/ui'

type SmsLogRow = {
  id: string
  phone: string
  message: string
  type: string
  status: string
  errorCode: string | null
  errorMessage: string | null
  requestId: string | null
  createdAt: string
}

type SmsData = {
  logs: SmsLogRow[]
  stats: { total: number; delivered: number; failed: number; queued: number; successPct: number }
  setting: { businessId: BusinessId; enabled: boolean; senderId: string }
}

export default function SmsSettingsPage() {
  const [businessId, setBusinessId] = useState<BusinessId>('ALMA_LIFESTYLE')
  const [status, setStatus] = useState('ALL')
  const [data, setData] = useState<SmsData | null>(null)
  const [balance, setBalance] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [phone, setPhone] = useState('')
  const [message, setMessage] = useState('ALMA SMS test')

  const balanceText = useMemo(() => {
    if (!balance) return '—'
    const text = JSON.stringify(balance)
    return text.length > 80 ? `${text.slice(0, 80)}...` : text
  }, [balance])

  async function load() {
    setLoading(true)
    const qs = new URLSearchParams({ business_id: businessId, status })
    const [logsRes, balanceRes] = await Promise.all([
      fetch(`/api/sms/logs?${qs}`, { cache: 'no-store' }),
      fetch('/api/sms/balance', { cache: 'no-store' }),
    ])
    if (logsRes.ok) setData(await logsRes.json())
    if (balanceRes.ok) setBalance(await balanceRes.json())
    setLoading(false)
  }

  useEffect(() => {
    void load()
  }, [businessId, status])

  async function saveEnabled(enabled: boolean) {
    const res = await fetch('/api/sms/logs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_id: businessId, enabled }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(json.error || 'Could not update SMS setting')
      return
    }
    toast.success(enabled ? 'SMS enabled' : 'SMS disabled')
    await load()
  }

  async function sendTest() {
    const res = await fetch('/api/sms/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_id: businessId, phone, message }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(json.error || json.reason || 'Could not send test SMS')
      return
    }
    toast.success('Test SMS queued')
    await load()
  }

  async function retry(id: string) {
    const res = await fetch('/api/sms/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (!res.ok) toast.error('Retry failed')
    else toast.success('Retry queued')
    await load()
  }

  async function report(id: string) {
    const res = await fetch('/api/sms/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (!res.ok) toast.error('Report check failed')
    else toast.success('Report refreshed')
    await load()
  }

  return (
    <>
      <PageHeader
        title="SMS"
        subtitle="SMS.NET.BD transactional SMS, balance, delivery logs, and retry controls."
        actions={<Button size="xs" variant="secondary" onClick={() => void load()}>Refresh</Button>}
      />
      <div className="p-4 md:p-6 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <KpiCard label="Total" value={loading ? '—' : data?.stats.total ?? 0} loading={loading} />
          <KpiCard label="Delivered" value={loading ? '—' : data?.stats.delivered ?? 0} loading={loading} />
          <KpiCard label="Failed" value={loading ? '—' : data?.stats.failed ?? 0} loading={loading} />
          <KpiCard label="Queued" value={loading ? '—' : data?.stats.queued ?? 0} loading={loading} />
          <KpiCard label="Success" value={loading ? '—' : `${data?.stats.successPct ?? 0}%`} loading={loading} />
        </div>

        <div className="grid lg:grid-cols-[380px_1fr] gap-4">
          <Card className="p-5 space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-bold text-cream">SMS control</p>
              <Select value={businessId} onChange={v => setBusinessId(v as BusinessId)} options={BUSINESS_LIST.map(b => ({ label: b.name, value: b.id }))} />
              <div className="flex gap-2">
                <Button variant={data?.setting.enabled ? 'gold' : 'secondary'} onClick={() => void saveEnabled(true)}>Enable</Button>
                <Button variant={!data?.setting.enabled ? 'gold' : 'secondary'} onClick={() => void saveEnabled(false)}>Disable</Button>
              </div>
              <p className="rounded-xl border border-border bg-black/20 p-3 text-[11px] text-zinc-400">
                Balance: <span className="font-mono text-gold-lt">{balanceText}</span>
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-bold text-cream">Test SMS</p>
              <Input value={phone} onChange={e => setPhone(e.target.value)} placeholder="01XXXXXXXXX or 8801XXXXXXXXX" />
              <textarea value={message} onChange={e => setMessage(e.target.value)} rows={4} className="w-full rounded-xl bg-card border border-border px-4 py-3 text-sm text-cream" />
              <Button variant="gold" onClick={() => void sendTest()} disabled={!phone.trim() || !message.trim()}>Send test SMS</Button>
            </div>
          </Card>

          <Card className="p-5">
            <div className="mb-4 flex flex-col md:flex-row md:items-center justify-between gap-2">
              <p className="text-sm font-bold text-cream">SMS logs</p>
              <Select value={status} onChange={setStatus} options={['ALL', 'QUEUED', 'PENDING', 'SENDING', 'SENT', 'DELIVERED', 'FAILED'].map(s => ({ label: s, value: s }))} />
            </div>
            {loading ? <Skeleton className="h-64" /> : !(data?.logs ?? []).length ? (
              <p className="text-xs text-zinc-600">No SMS logs yet.</p>
            ) : (
              <div className="table-scroll">
                <table className="w-full min-w-[900px] text-left text-[11px]">
                  <thead className="border-b border-border text-zinc-500">
                    <tr>
                      <th className="py-2 pr-3">Created</th>
                      <th className="py-2 pr-3">Phone</th>
                      <th className="py-2 pr-3">Type</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">Message</th>
                      <th className="py-2 pr-3">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.logs.map(row => (
                      <tr key={row.id} className="border-b border-border/50">
                        <td className="py-2 pr-3 font-mono text-zinc-500">{new Date(row.createdAt).toLocaleString()}</td>
                        <td className="py-2 pr-3 font-mono">{row.phone}</td>
                        <td className="py-2 pr-3">{row.type}</td>
                        <td className="py-2 pr-3">{row.status}<span className="block text-red-400">{row.errorCode || ''}</span></td>
                        <td className="py-2 pr-3 text-zinc-400 max-w-sm truncate" title={row.message}>{row.message}</td>
                        <td className="py-2 pr-3">
                          <div className="flex gap-1">
                            {row.status === 'FAILED' && <Button size="xs" variant="secondary" onClick={() => void retry(row.id)}>Retry</Button>}
                            {row.requestId && <Button size="xs" variant="ghost" onClick={() => void report(row.id)}>Report</Button>}
                          </div>
                        </td>
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
