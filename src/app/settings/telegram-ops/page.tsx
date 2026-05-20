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

type Dashboard = {
  ownerRouting?: {
    source: string
    chatIds: string[]
    dbIds: string[]
    envIds: string[]
    invalidDbTokens?: string[]
    invalidEnvTokens?: string[]
  }
  telegram?: {
    botOk?: boolean
    botUsername?: string | null
    webhookHealthy?: boolean
    webhookUrl?: string | null
    expectedWebhookUrl?: string | null
  }
  queue?: {
    byStatus?: Array<{ status: string; count: number }>
    stuckSending?: number
    businessPending?: number
    businessFailed24h?: number
    stats7d?: Array<{ status: string; count: number }>
  }
  delivery?: {
    lastSuccessfulSend?: { sentAt: string | null; eventType: string; chatId: string } | null
    lastFailed?: { at: string; eventType: string; errorMessage: string | null } | null
    sentLast24h?: number
    recentFailures?: Array<{ id: string; eventType: string; errorMessage: string | null; attempts: number }>
  }
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
  { key: 'alertWorkflowLifecycle', label: 'Approvals · approve / reject / submit' },
  { key: 'alertOpsDailySummary', label: 'Daily ops summary' },
]

function minutesToTimeLabel(minutes: number) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const period = h >= 12 ? 'PM' : 'AM'
  const hour12 = h % 12 || 12
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`
}

function routingLabel(source: string) {
  switch (source) {
    case 'database':
      return 'Database (primary)'
    case 'env_fallback':
      return 'Env fallback (TELEGRAM_OWNER_CHAT_IDS)'
    case 'disabled':
      return 'Disabled'
    default:
      return 'No valid recipients'
  }
}

export default function TelegramOpsSettingsPage() {
  const [businessId, setBusinessId] = useState<BusinessId>('ALMA_TRADING')
  const [data, setData] = useState<ApiData | null>(null)
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [testing, setTesting] = useState(false)
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
      setDashboard((await healthRes.json()) as Dashboard)
    } else {
      setDashboard(null)
    }
    setLoading(false)
  }

  async function processQueueNow() {
    setProcessing(true)
    const res = await fetch(`/api/settings/telegram-ops/health?business_id=${businessId}`, { method: 'POST' })
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

  async function sendTestNotification() {
    setTesting(true)
    const res = await fetch('/api/settings/telegram-ops/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_id: businessId }),
    })
    const json = await res.json().catch(() => ({}))
    setTesting(false)
    if (!res.ok || !(json as { ok?: boolean }).ok) {
      toast.error((json as { error?: string }).error || 'Test send failed')
      return
    }
    const routing = (json as { routing?: { source?: string; chatIds?: string[] } }).routing
    toast.success(`Test sent to ${routing?.chatIds?.length ?? 0} owner chat(s) via ${routing?.source ?? 'routing'}`)
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
  const routing = dashboard?.ownerRouting
  const queueStats = Object.fromEntries((dashboard?.queue?.stats7d || []).map(s => [s.status, s.count]))

  return (
    <>
      <PageHeader
        title="Telegram Ops"
        subtitle="Production health · owner routing · async delivery queue"
        actions={(
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="gold" disabled={testing} onClick={() => void sendTestNotification()}>
              {testing ? 'Sending…' : 'Send test'}
            </Button>
            <Button size="xs" variant="secondary" disabled={processing} onClick={() => void processQueueNow()}>
              {processing ? 'Processing…' : 'Process queue'}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => void load()}>Refresh</Button>
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
          <>
            <Card className="grid gap-3 p-5 md:grid-cols-2 lg:grid-cols-4">
              <HealthStat
                label="Bot"
                value={dashboard?.telegram?.botOk ? `@${dashboard.telegram.botUsername || 'ok'}` : 'Offline / misconfigured'}
                tone={dashboard?.telegram?.botOk ? 'ok' : 'bad'}
              />
              <HealthStat
                label="Webhook"
                value={dashboard?.telegram?.webhookHealthy ? 'Healthy' : 'Check URL'}
                tone={dashboard?.telegram?.webhookHealthy ? 'ok' : 'warn'}
                hint={dashboard?.telegram?.expectedWebhookUrl || undefined}
              />
              <HealthStat
                label="Owner routing"
                value={routingLabel(routing?.source || 'none')}
                tone={routing?.chatIds?.length ? 'ok' : 'bad'}
                hint={routing?.chatIds?.join(', ')}
              />
              <HealthStat
                label="Pending queue"
                value={String(dashboard?.queue?.businessPending ?? 0)}
                tone={(dashboard?.queue?.businessPending ?? 0) > 0 ? 'warn' : 'ok'}
              />
              <HealthStat
                label="Stuck SENDING"
                value={String(dashboard?.queue?.stuckSending ?? 0)}
                tone={(dashboard?.queue?.stuckSending ?? 0) > 0 ? 'bad' : 'ok'}
              />
              <HealthStat
                label="Failed (24h)"
                value={String(dashboard?.queue?.businessFailed24h ?? 0)}
                tone={(dashboard?.queue?.businessFailed24h ?? 0) > 0 ? 'warn' : 'ok'}
              />
              <HealthStat
                label="Sent (24h)"
                value={String(dashboard?.delivery?.sentLast24h ?? 0)}
                tone="ok"
              />
              <HealthStat
                label="Last success"
                value={
                  dashboard?.delivery?.lastSuccessfulSend?.sentAt
                    ? new Date(dashboard.delivery.lastSuccessfulSend.sentAt).toLocaleString()
                    : '—'
                }
                tone={dashboard?.delivery?.lastSuccessfulSend ? 'ok' : 'warn'}
                hint={dashboard?.delivery?.lastSuccessfulSend?.eventType}
              />
            </Card>

            {routing && (
              <Card className="p-4 text-[11px] text-zinc-400">
                <p className="font-bold text-cream">Owner routing diagnostics</p>
                <p className="mt-2">
                  Active source: <span className="text-gold-lt">{routingLabel(routing.source)}</span>
                  {' · '}
                  Delivering to: <span className="font-mono text-zinc-300">{routing.chatIds.join(', ') || '—'}</span>
                </p>
                <p className="mt-1">
                  DB IDs: {routing.dbIds.join(', ') || '—'} · Env fallback IDs: {routing.envIds.join(', ') || '—'}
                </p>
                {(routing.invalidDbTokens?.length || routing.invalidEnvTokens?.length) ? (
                  <p className="mt-1 text-amber-300">
                    Invalid tokens ignored: DB [{routing.invalidDbTokens?.join(', ')}] Env [{routing.invalidEnvTokens?.join(', ')}]
                  </p>
                ) : null}
                <p className="mt-2 text-zinc-500">
                  Priority: database chat IDs first. If empty or invalid, <code className="text-gold-lt">TELEGRAM_OWNER_CHAT_IDS</code> env is used.
                </p>
              </Card>
            )}

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
                <p className="text-[11px] text-zinc-500">Owner chat IDs (comma-separated). Env fallback: TELEGRAM_OWNER_CHAT_IDS</p>
                <Input
                  value={ownerChatIds}
                  onChange={e => setOwnerChatIds(e.target.value)}
                  placeholder="1949042834, -1001234567890"
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

                <p className="pt-2 text-sm font-bold text-cream">Queue (7 days)</p>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full bg-zinc-800 px-2 py-1 text-zinc-400">SENT: {queueStats.SENT ?? 0}</span>
                  <span className="rounded-full bg-zinc-800 px-2 py-1 text-zinc-400">QUEUED: {queueStats.QUEUED ?? 0}</span>
                  <span className="rounded-full bg-zinc-800 px-2 py-1 text-zinc-400">FAILED: {queueStats.FAILED ?? 0}</span>
                  <span className="rounded-full bg-zinc-800 px-2 py-1 text-zinc-400">SENDING: {queueStats.SENDING ?? 0}</span>
                </div>

                {dashboard?.delivery?.lastFailed && (
                  <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-[11px] text-red-200/90">
                    <p className="font-bold">Last failure</p>
                    <p className="mt-1">{dashboard.delivery.lastFailed.eventType}</p>
                    <p className="mt-1 break-words">{dashboard.delivery.lastFailed.errorMessage}</p>
                  </div>
                )}

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
                        <p className="mt-1 break-words text-red-400/90">{row.errorMessage}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </>
        )}
      </div>
    </>
  )
}

function HealthStat({
  label,
  value,
  tone,
  hint,
}: {
  label: string
  value: string
  tone: 'ok' | 'warn' | 'bad'
  hint?: string
}) {
  const color = tone === 'ok' ? 'text-green-300' : tone === 'warn' ? 'text-amber-300' : 'text-red-300'
  return (
    <div className="rounded-xl border border-border/60 bg-black/20 p-3">
      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-zinc-600">{label}</p>
      <p className={`mt-1 text-sm font-bold ${color}`}>{value}</p>
      {hint ? <p className="mt-1 truncate text-[10px] text-zinc-500" title={hint}>{hint}</p> : null}
    </div>
  )
}
