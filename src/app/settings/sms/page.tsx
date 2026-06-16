'use client'

import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { BUSINESS_LIST, type BusinessId } from '@/lib/businesses'
import type { SmsType } from '@/lib/sms/types'
import { DEFAULT_SMS_ENABLED_TYPES, SMS_TYPE_CATALOG } from '@/lib/sms/catalog'
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

type SmsSettingState = {
  businessId: BusinessId
  enabled: boolean
  senderId: string
  enabledTypes: SmsType[]
}

type SmsData = {
  logs: SmsLogRow[]
  stats: { total: number; delivered: number; failed: number; queued: number; successPct: number }
  setting: SmsSettingState
}

export default function SmsSettingsPage() {
  const [businessId, setBusinessId] = useState<BusinessId>('ALMA_LIFESTYLE')
  const [status, setStatus] = useState('ALL')
  const [data, setData] = useState<SmsData | null>(null)
  const [balance, setBalance] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [savingTypes, setSavingTypes] = useState(false)
  const [testPhone, setTestPhone] = useState('')
  const [testing, setTesting] = useState(false)
  const [enabledTypes, setEnabledTypes] = useState<SmsType[]>([...DEFAULT_SMS_ENABLED_TYPES])

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
    if (logsRes.ok) {
      const json = await logsRes.json() as SmsData
      setData(json)
      setEnabledTypes(json.setting?.enabledTypes?.length ? json.setting.enabledTypes : [...DEFAULT_SMS_ENABLED_TYPES])
    } else {
      const err = await logsRes.json().catch(() => ({})) as { error?: string }
      toast.error(err.error || 'SMS settings load failed')
    }
    if (balanceRes.ok) setBalance(await balanceRes.json())
    setLoading(false)
  }

  useEffect(() => {
    void load()
  }, [businessId, status])

  async function patchSetting(patch: {
    enabled?: boolean
    senderId?: string
    enabled_types?: SmsType[]
  }) {
    const res = await fetch('/api/sms/logs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_id: businessId, ...patch }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(json.error || 'Could not save SMS settings')
      return false
    }
    if (Array.isArray(json.enabledTypes)) setEnabledTypes(json.enabledTypes)
    await load()
    return true
  }

  async function saveEnabled(enabled: boolean) {
    const ok = await patchSetting({ enabled })
    if (!ok) return
    toast.success(enabled ? 'SMS enabled for this business' : 'SMS disabled')
  }

  async function saveTypes() {
    setSavingTypes(true)
    const ok = await patchSetting({ enabled_types: enabledTypes })
    setSavingTypes(false)
    if (!ok) return
    toast.success('SMS types saved')
  }

  function toggleType(type: SmsType, checked: boolean) {
    setEnabledTypes(prev => {
      const set = new Set(prev)
      if (checked) set.add(type)
      else set.delete(type)
      return [...set]
    })
  }

  async function sendTestSms() {
    if (!testPhone.trim()) {
      toast.error('Test phone number দিন')
      return
    }
    setTesting(true)
    const res = await fetch('/api/sms/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_id: businessId, phone: testPhone.trim() }),
    })
    const json = await res.json().catch(() => ({}))
    setTesting(false)
    if (!res.ok) {
      toast.error(json.error || 'Test SMS failed')
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

  const catalog = SMS_TYPE_CATALOG

  return (
    <>
      <PageHeader
        title="SMS"
        subtitle="কোন জায়গায় SMS যাবে তা এখান থেকে নিজে চালু/বন্ধ করুন — কোডিং লাগবে না।"
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

        <div className="grid lg:grid-cols-[420px_1fr] gap-4">
          <div className="space-y-4">
            <Card className="p-5 space-y-4">
              <div className="space-y-2">
                <p className="text-sm font-bold text-cream">Business & master switch</p>
                <Select value={businessId} onChange={v => setBusinessId(v as BusinessId)} options={BUSINESS_LIST.map(b => ({ label: b.name, value: b.id }))} />
                <div className="flex gap-2">
                  <Button variant={data?.setting.enabled ? 'gold' : 'secondary'} onClick={() => void saveEnabled(true)}>Enable SMS</Button>
                  <Button variant={!data?.setting.enabled ? 'gold' : 'secondary'} onClick={() => void saveEnabled(false)}>Disable SMS</Button>
                </div>
                <p className="rounded-xl border border-border bg-black/[0.03] p-3 text-[11px] text-zinc-400">
                  Balance: <span className="font-mono text-gold-lt">{balanceText}</span>
                </p>
                <p className="text-[10px] text-zinc-500 leading-relaxed">
                  Recharge-এর পর <span className="text-zinc-300">Enable SMS</span> চাপুন। Master switch বন্ধ থাকলে নিচের কোনো type চালু থাকলেও SMS যাবে না।
                </p>
              </div>
            </Card>

            <Card className="p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-bold text-cream">কোন SMS চালু থাকবে</p>
                <Button size="xs" variant="gold" disabled={savingTypes} onClick={() => void saveTypes()}>
                  {savingTypes ? 'Saving…' : 'Save types'}
                </Button>
              </div>
              {loading ? (
                <Skeleton className="h-48" />
              ) : (
                catalog.map(item => (
                  <label
                    key={item.type}
                    className="flex items-start gap-3 rounded-xl border border-border px-3 py-3 text-sm text-zinc-300"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0"
                      checked={enabledTypes.includes(item.type)}
                      onChange={e => toggleType(item.type, e.target.checked)}
                    />
                    <span className="min-w-0">
                      <span className="block font-semibold text-cream">{item.labelBn}</span>
                      <span className="block text-[11px] text-zinc-500">{item.label} · {item.type}</span>
                      <span className="mt-1 block text-[11px] text-zinc-400 leading-relaxed">{item.description}</span>
                      <span className="mt-1 block text-[10px] text-zinc-600">কে পাবে: {item.audience}</span>
                    </span>
                  </label>
                ))
              )}
            </Card>

            <Card className="p-5 space-y-3">
              <p className="text-sm font-bold text-cream">Test SMS</p>
              <p className="text-[11px] text-zinc-500">
                উপরে <span className="text-zinc-300">Test SMS</span> type চালু রাখুন, তারপর নম্বর দিয়ে test পাঠান।
              </p>
              <Input
                placeholder="01XXXXXXXXX"
                value={testPhone}
                onChange={e => setTestPhone(e.target.value)}
              />
              <Button size="sm" variant="secondary" disabled={testing} onClick={() => void sendTestSms()}>
                {testing ? 'Sending…' : 'Send test SMS'}
              </Button>
            </Card>
          </div>

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
                        <td className="py-2 pr-3">
                          {row.status}
                          <span className="block text-red-400">{row.errorCode || ''}</span>
                          {row.errorMessage && (
                            <span className="block text-[10px] text-zinc-500 max-w-xs truncate" title={row.errorMessage}>
                              {row.errorMessage}
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-zinc-400 max-w-sm truncate" title={row.message}>{row.message}</td>
                        <td className="py-2 pr-3">
                          <div className="flex gap-1">
                            {row.status === 'FAILED' && row.errorCode !== 'CANCELLED' && (
                              <Button size="xs" variant="secondary" onClick={() => void retry(row.id)}>Retry</Button>
                            )}
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
