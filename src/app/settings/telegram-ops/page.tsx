'use client'

import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { BUSINESS_LIST, type BusinessId } from '@/lib/businesses'
import { Button, Card, Input, PageHeader, Select, Skeleton } from '@/components/ui'
import { EmployeeAvatar } from '@/components/profile/EmployeeAvatar'
import type { TelegramOpsSettingDto } from '@/lib/telegram-notification/types'

type QueueRow = {
  id: string
  eventType: string
  status: string
  chatId: string
  attempts: number
  errorMessage: string | null
  createdAt: string
  userId?: string | null
  employeeName?: string | null
  profileImageUrl?: string | null
}

type ApiData = {
  setting: TelegramOpsSettingDto
  recentQueue: QueueRow[]
  stats: Array<{ status: string; count: number }>
}

const ALERT_TOGGLES: Array<{ key: keyof TelegramOpsSettingDto; label: string }> = [
  { key: 'alertAttendanceCheckIn', label: 'Check-in + face verification alerts' },
  { key: 'alertAttendanceLate', label: 'Late detail on check-in' },
  { key: 'alertAttendanceAbsent', label: 'Absent / not arrived' },
  { key: 'alertAttendanceCheckOut', label: 'Check-out alerts' },
  { key: 'alertAttendanceNoCheckout', label: 'Missing checkout' },
  { key: 'alertAttendanceEarlyLeave', label: 'Early leave' },
  { key: 'alertAttendanceSuspicious', label: 'Suspicious check-in' },
  { key: 'alertTradingScreenshot', label: 'Screenshot upload/failure' },
  { key: 'alertTradingDeleteRequest', label: 'Delete requests' },
  { key: 'alertOpsDailySummary', label: 'Daily ops summary' },
]

function minutesToTimeLabel(minutes: number) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const period = h >= 12 ? 'PM' : 'AM'
  const hour12 = h % 12 || 12
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`
}

export default function TelegramOpsSettingsPage() {
  const [businessId, setBusinessId] = useState<BusinessId>('ALMA_TRADING')
  const [data, setData] = useState<ApiData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [health, setHealth] = useState<Record<string, unknown> | null>(null)
  const [ownerChatIds, setOwnerChatIds] = useState('')

  async function load() {
    setLoading(true)
    const [res, healthRes] = await Promise.all([
      fetch(`/api/settings/telegram-ops?business_id=${businessId}`, { cache: 'no-store' }),
      fetch(`/api/settings/telegram-ops/health?business_id=${businessId}`, { cache: 'no-store' }),
    ])
    if (res.ok) {
      const json = (await res.json()) as ApiData
      setData(json)
      setOwnerChatIds(json.setting.ownerChatIds)
    } else {
      toast.error('Could not load Telegram ops settings')
    }
    if (healthRes.ok) {
      setHealth((await healthRes.json()) as Record<string, unknown>)
    } else {
      setHealth(null)
    }
    setLoading(false)
  }

  async function processQueueNow() {
    setProcessing(true)
    const res = await fetch('/api/settings/telegram-ops/health', { method: 'POST' })
    const json = await res.json().catch(() => ({}))
    setProcessing(false)
    if (!res.ok) {
      toast.error((json as { error?: string }).error || 'Queue processing failed')
      return
    }
    const reclaimed = (json as { reclaimed?: number }).reclaimed ?? 0
    const processed = (json as { processed?: { processed?: number } }).processed?.processed ?? 0
    toast.success(`Reclaimed ${reclaimed} stuck · processed ${processed}`)
    await load()
  }

  useEffect(() => {
    void load()
  }, [businessId])

  async function retryQueue(id: string) {
    const res = await fetch('/api/settings/telegram-ops/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error((json as { error?: string }).error || 'Retry failed')
      return
    }
    toast.success('Retry queued')
    await load()
  }

  async function save(patch: Partial<TelegramOpsSettingDto>) {
    setSaving(true)
    const res = await fetch('/api/settings/telegram-ops', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_id: businessId, ...patch }),
    })
    const json = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) {
      toast.error((json as { error?: string }).error || 'Save failed')
      return
    }
    toast.success('Saved')
    await load()
  }

  const setting = data?.setting

  return (
    <>
      <PageHeader
        title="Telegram Ops"
        subtitle="Owner control center · async queue · Asia/Dhaka schedules"
        actions={(
          <div className="flex gap-2">
            <Button size="xs" variant="gold" disabled={processing} onClick={() => void processQueueNow()}>
              {processing ? 'Processing…' : 'Process queue'}
            </Button>
            <Button size="xs" variant="secondary" onClick={() => void load()}>Refresh</Button>
          </div>
        )}
      />
      <div className="space-y-4 p-4 md:p-6">
        <Select
          value={businessId}
          onChange={v => setBusinessId(v as BusinessId)}
          options={BUSINESS_LIST.map(b => ({ label: b.name, value: b.id }))}
        />

        {loading || !setting ? (
          <Skeleton className="h-64 w-full rounded-2xl" />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="space-y-4 p-5">
              <p className="text-sm font-bold text-cream">Recipients & master switch</p>
              <div className="flex gap-2">
                <Button variant={setting.enabled ? 'gold' : 'secondary'} onClick={() => void save({ enabled: true })} disabled={saving}>
                  Enabled
                </Button>
                <Button variant={!setting.enabled ? 'gold' : 'secondary'} onClick={() => void save({ enabled: false })} disabled={saving}>
                  Disabled
                </Button>
              </div>
              <p className="text-[11px] text-zinc-500">Owner chat IDs (comma-separated). Fallback: TELEGRAM_OWNER_CHAT_IDS env.</p>
              <Input
                value={ownerChatIds}
                onChange={e => setOwnerChatIds(e.target.value)}
                placeholder="-1001234567890, 123456789"
              />
              <Button variant="gold" onClick={() => void save({ ownerChatIds })} disabled={saving}>
                Save chat IDs
              </Button>

              <p className="text-sm font-bold text-cream">Schedule (BD)</p>
              <p className="text-[11px] text-zinc-500">
                Office {minutesToTimeLabel(setting.officeStartMinutes)} · grace +{setting.gracePeriodMinutes}m ·
                no-checkout {minutesToTimeLabel(setting.checkoutCutoffMinutes)}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ['officeStartMinutes', 'Office start (min)'],
                    ['gracePeriodMinutes', 'Grace (min)'],
                    ['checkoutCutoffMinutes', 'Checkout cutoff (min)'],
                    ['earlyLeaveMinutes', 'Early leave under (min)'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="block text-[11px] text-zinc-500">
                    {label}
                    <Input
                      type="number"
                      className="mt-1"
                      value={String(setting[key])}
                      onChange={e =>
                        setData(d =>
                          d
                            ? {
                                ...d,
                                setting: { ...d.setting, [key]: Number(e.target.value) },
                              }
                            : d,
                        )
                      }
                      onBlur={() => void save({ [key]: setting[key] })}
                    />
                  </label>
                ))}
              </div>
            </Card>

            <Card className="space-y-3 p-5">
              <p className="text-sm font-bold text-cream">Alert toggles</p>
              {ALERT_TOGGLES.map(t => (
                <label
                  key={t.key}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-sm text-zinc-300"
                >
                  {t.label}
                  <input
                    type="checkbox"
                    checked={Boolean(setting[t.key])}
                    onChange={e => void save({ [t.key]: e.target.checked } as Partial<TelegramOpsSettingDto>)}
                    className="h-4 w-4"
                  />
                </label>
              ))}

              {health && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-[11px] text-zinc-400">
                  <p className="font-bold text-amber-200/90">Delivery health</p>
                  <p className="mt-1">
                    Bot: {(health.telegram as { botUsername?: string })?.botUsername || '—'} ·
                    Token: {(health.queue as { botTokenConfigured?: boolean })?.botTokenConfigured ? 'ok' : 'missing'} ·
                    Stuck SENDING: {(health.queue as { stuckSending?: number })?.stuckSending ?? 0}
                  </p>
                </div>
              )}

              <p className="pt-2 text-sm font-bold text-cream">Queue (7 days)</p>
              <div className="flex flex-wrap gap-2 text-xs">
                {(data.stats || []).map(s => (
                  <span key={s.status} className="rounded-full bg-zinc-800 px-2 py-1 text-zinc-400">
                    {s.status}: {s.count}
                  </span>
                ))}
              </div>
              <ul className="max-h-56 space-y-2 overflow-y-auto text-[11px] text-zinc-500">
                {data.recentQueue.map(row => (
                  <li key={row.id} className="rounded-lg border border-border/60 p-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-zinc-300">
                        <EmployeeAvatar
                          userId={row.userId}
                          name={row.employeeName || row.eventType}
                          imageUrl={row.profileImageUrl}
                          size="xs"
                        />
                        {row.eventType} · <b>{row.status}</b>
                        {row.employeeName ? <span className="text-zinc-500">· {row.employeeName}</span> : null}
                      </span>
                      {(row.status === 'FAILED' || row.status === 'QUEUED' || row.status === 'SENDING') && (
                        <Button size="xs" variant="secondary" onClick={() => void retryQueue(row.id)}>
                          Retry
                        </Button>
                      )}
                    </div>
                    <div>Chat {row.chatId} · attempts {row.attempts}</div>
                    <div>{new Date(row.createdAt).toLocaleString()}</div>
                    {row.errorMessage ? (
                      <p className="mt-1 text-red-400/90 break-words">{row.errorMessage}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        )}
      </div>
    </>
  )
}
