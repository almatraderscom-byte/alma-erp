'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts'
import { cn } from '@/lib/utils'

type DashboardData = {
  todayDhakaDate?: string
  todayUsd: number
  todayOxylabsCredits?: number
  monthUsd: number
  forecastUsd: number
  subscriptionAmortMonthUsd: number
  dailyLast30: Array<Record<string, number | string>>
  byProvider: Array<{ provider: string; totalUsd: number }>
  byModel?: Array<{ modelId: string; label: string; provider: string; monthUsd: number; todayUsd: number }>
  modelDailyLast30?: Array<Record<string, number | string>>
  topConversations: Array<{ conversationId: string; title: string | null; totalUsd: number }>
  telegramTodayUsd: number
  telegramMonthUsd: number
  telegramDailyLast30: Array<{ date: string; totalUsd: number }>
  topTelegramConversations: Array<{ conversationId: string; title: string | null; totalUsd: number }>
  subscriptions: Array<{
    id: string; name: string; amount: number; currency: string
    billingCycle: string; nextRenewalAt: string; category: string | null
    dailyUsd: number
  }>
  budgets: { dailyUsd: number | null; monthlyUsd: number | null }
  dailyBudgetPct?: number | null
  monthlyBudgetPct?: number | null
  googleTts?: {
    today: {
      total: { costUsd: number; characters: number; minutesUsed: number; synthesisCount: number }
      phoneCalls: { costUsd: number; characters: number; minutesUsed: number; synthesisCount: number; callCount: number }
      voiceMessages: { costUsd: number; characters: number; minutesUsed: number; synthesisCount: number }
    }
    month: {
      total: { costUsd: number; characters: number; minutesUsed: number; synthesisCount: number }
      phoneCalls: { costUsd: number; characters: number; minutesUsed: number; synthesisCount: number; callCount: number }
      voiceMessages: { costUsd: number; characters: number; minutesUsed: number; synthesisCount: number }
    }
    priceNote: string
    twilioCallsToday: { callCount: number; minutesUsed: number; costUsd: number }
    twilioCallsMonth: { callCount: number; minutesUsed: number; costUsd: number }
  }
  elevenLabs?: {
    today: {
      total: { costUsd: number; characters: number; minutesUsed: number; synthesisCount: number }
      phoneCalls: { costUsd: number; characters: number; minutesUsed: number; synthesisCount: number; callCount: number }
      voiceMessages: { costUsd: number; characters: number; minutesUsed: number; synthesisCount: number }
    }
    month: {
      total: { costUsd: number; characters: number; minutesUsed: number; synthesisCount: number }
      phoneCalls: { costUsd: number; characters: number; minutesUsed: number; synthesisCount: number; callCount: number }
      voiceMessages: { costUsd: number; characters: number; minutesUsed: number; synthesisCount: number }
    }
    priceNote: string
  }
}

type BalanceProviderRow = {
  id: string
  label: string
  balanceUsd: number | null
  todayUsd: number | null
  monthUsd: number | null
  source: string
  free?: boolean
}

type BalanceData = {
  checkedAt: string
  providers: BalanceProviderRow[]
  summaryLine: string
}

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#E07A5F',
  openai: '#81B29A',
  openrouter: '#A78BFA',
  gemini: '#3B82F6',
  google_tts: '#8B5CF6',
  twilio: '#D4A84B',
  elevenlabs: '#EC4899',
  veo: '#0EA5E9',
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  gemini: 'Gemini',
  google_tts: 'Google TTS',
  twilio: 'Twilio',
  elevenlabs: 'ElevenLabs',
  veo: 'VEO 3',
  oxylabs: 'Oxylabs',
}

// Stable color cycle for the per-model chart (model ids don't have fixed colors
// like providers do; assign deterministically by index for visual consistency).
const MODEL_CHART_COLORS = [
  '#E07A5F', '#81B29A', '#A78BFA', '#3B82F6', '#D4A84B',
  '#EC4899', '#0EA5E9', '#10B981', '#F59E0B', '#6366F1',
  '#94a3b8',
]

function fmtUsd(n: number) {
  return `$${n.toFixed(n < 0.01 && n > 0 ? 4 : 2)}`
}

function renewalBadge(dateStr: string) {
  const today = new Date()
  const renewal = new Date(dateStr + 'T00:00:00')
  const days = Math.ceil((renewal.getTime() - today.getTime()) / 86400000)
  if (days < 0) return { label: 'মেয়াদোত্তীর্ণ', cls: 'bg-red-50 border border-red-200 text-red-600 shadow-sm' }
  if (days <= 3) return { label: `${days} দিন`, cls: 'bg-amber-50 border border-amber-200 text-amber-700 shadow-sm' }
  if (days <= 14) return { label: `${days} দিন`, cls: 'bg-[#E07A5F]/10 border border-[#E07A5F]/20 text-[#E07A5F]' }
  return { label: `${days} দিন`, cls: 'bg-transparent border border-border-subtle text-muted' }
}

function fmtBalanceCell(row: BalanceProviderRow) {
  if (row.free) return 'Free'
  if (row.balanceUsd == null) return '—'
  return fmtUsd(row.balanceUsd)
}

function fmtSpendCell(n: number | null, providerId?: string) {
  if (n == null) return '—'
  if (providerId === 'oxylabs') return `${Math.round(n)} ক্রেডিট`
  return fmtUsd(n)
}

function fmtCheckedAt(iso: string) {
  try {
    return new Date(iso).toLocaleString('bn-BD', {
      timeZone: 'Asia/Dhaka',
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  } catch {
    return iso
  }
}

function balanceColor(row: BalanceProviderRow): string {
  if (row.free) return 'text-emerald-600'
  if (row.balanceUsd == null) return 'text-muted'
  if (row.balanceUsd < 1) return 'text-red-500'
  if (row.balanceUsd < 5) return 'text-amber-600'
  return 'text-emerald-600'
}

const staggerContainer = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.08 },
  },
}

const staggerItem = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: 'easeOut' } },
}

const STAT_GLOWS = [
  'shadow-[0_2px_12px_rgba(224,122,95,0.08)]',
  'shadow-[0_2px_12px_rgba(212,168,75,0.08)]',
  'shadow-[0_2px_12px_rgba(129,178,154,0.08)]',
  'shadow-[0_2px_12px_rgba(59,130,246,0.08)]',
]

function TtsProviderCard({
  title,
  accent,
  borderClass,
  gradientClass,
  priceNote,
  todayCalls,
  monthCalls,
  todayVoice,
  monthVoice,
  twilioToday,
  twilioMonth,
  callLabel = 'ফোন কল',
  primaryMode = 'calls',
}: {
  title: string
  accent: string
  borderClass: string
  gradientClass: string
  priceNote: string
  todayCalls: { minutesUsed: number; costUsd: number; characters: number; callCount: number }
  monthCalls: { minutesUsed: number; costUsd: number; characters: number; callCount: number }
  todayVoice: { minutesUsed: number; costUsd: number; characters: number; synthesisCount: number }
  monthVoice: { minutesUsed: number; costUsd: number; characters: number; synthesisCount: number }
  twilioToday?: { callCount: number; minutesUsed: number; costUsd: number }
  twilioMonth?: { callCount: number; minutesUsed: number; costUsd: number }
  callLabel?: string
  primaryMode?: 'calls' | 'voice'
}) {
  const todayCallCount = twilioToday?.callCount ?? todayCalls.callCount
  const monthCallCount = twilioMonth?.callCount ?? monthCalls.callCount

  const callGrid = (
    <>
      <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted">{callLabel}</p>
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-border-subtle bg-card/80 px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-wider text-muted">আজ — মিনিট</p>
          <p className="mt-1 text-lg font-bold text-cream tabular-nums">{todayCalls.minutesUsed}</p>
          <p className="text-[10px] text-muted">{fmtUsd(todayCalls.costUsd)}</p>
        </div>
        <div className="rounded-xl border border-border-subtle bg-card/80 px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-wider text-muted">আজ — ক্যারেক্টার</p>
          <p className="mt-1 text-lg font-bold text-cream tabular-nums">{todayCalls.characters.toLocaleString()}</p>
          <p className="text-[10px] text-muted">{todayCallCount} calls</p>
        </div>
        <div className="rounded-xl border border-border-subtle bg-card/80 px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-wider text-muted">মাস — মিনিট</p>
          <p className="mt-1 text-lg font-bold text-cream tabular-nums">{monthCalls.minutesUsed}</p>
          <p className="text-[10px] text-muted">{fmtUsd(monthCalls.costUsd)}</p>
        </div>
        <div className="rounded-xl border border-border-subtle bg-card/80 px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-wider text-muted">মাস — ক্যারেক্টার</p>
          <p className="mt-1 text-lg font-bold text-cream tabular-nums">{monthCalls.characters.toLocaleString()}</p>
          <p className="text-[10px] text-muted">{monthCallCount} calls</p>
        </div>
      </div>
      {twilioToday && (
        <p className="mb-3 text-[10px] text-muted">
          Twilio: আজ {twilioToday.callCount} কল · ~{twilioToday.minutesUsed}m · {fmtUsd(twilioToday.costUsd)}
          {twilioMonth ? ` · মাসে ${twilioMonth.callCount} কল · ~${twilioMonth.minutesUsed}m` : ''}
        </p>
      )}
    </>
  )

  const voiceGrid = (
    <>
      <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted">ভয়েস মেসেজ / voice reply</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-border-subtle bg-card/80 px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-wider text-muted">আজ — মিনিট</p>
          <p className="mt-1 text-lg font-bold text-cream tabular-nums">{todayVoice.minutesUsed}</p>
          <p className="text-[10px] text-muted">{fmtUsd(todayVoice.costUsd)}</p>
        </div>
        <div className="rounded-xl border border-border-subtle bg-card/80 px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-wider text-muted">আজ — ক্যারেক্টার</p>
          <p className="mt-1 text-lg font-bold text-cream tabular-nums">{todayVoice.characters.toLocaleString()}</p>
          <p className="text-[10px] text-muted">{todayVoice.synthesisCount} synthesis</p>
        </div>
        <div className="rounded-xl border border-border-subtle bg-card/80 px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-wider text-muted">মাস — মিনিট</p>
          <p className="mt-1 text-lg font-bold text-cream tabular-nums">{monthVoice.minutesUsed}</p>
          <p className="text-[10px] text-muted">{fmtUsd(monthVoice.costUsd)}</p>
        </div>
        <div className="rounded-xl border border-border-subtle bg-card/80 px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-wider text-muted">মাস — ক্যারেক্টার</p>
          <p className="mt-1 text-lg font-bold text-cream tabular-nums">{monthVoice.characters.toLocaleString()}</p>
          <p className="text-[10px] text-muted">{monthVoice.synthesisCount} synthesis</p>
        </div>
      </div>
    </>
  )

  const showCallsSecondary = primaryMode === 'voice' && (todayCalls.callCount > 0 || monthCalls.callCount > 0)

  return (
    <div className={cn('rounded-2xl border p-4 shadow-sm', borderClass, gradientClass)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className={cn('text-xs font-semibold', accent)}>{title}</p>
        <p className="text-[10px] text-muted">{priceNote}</p>
      </div>

      {primaryMode === 'calls' ? (
        <>
          {callGrid}
          {(todayVoice.synthesisCount > 0 || monthVoice.synthesisCount > 0) && (
            <div className="mt-1 border-t border-border-subtle pt-3">{voiceGrid}</div>
          )}
        </>
      ) : (
        <>
          {voiceGrid}
          {showCallsSecondary && (
            <div className="mt-3 border-t border-border-subtle pt-3">{callGrid}</div>
          )}
        </>
      )}
    </div>
  )
}

export default function AgentCostsDashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [balances, setBalances] = useState<BalanceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshingBalances, setRefreshingBalances] = useState(false)
  const [budgetDaily, setBudgetDaily] = useState('')
  const [budgetMonthly, setBudgetMonthly] = useState('')
  const [savingBudget, setSavingBudget] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [summaryRes, balanceRes] = await Promise.all([
        fetch('/api/assistant/costs/summary'),
        fetch('/api/assistant/costs/balances'),
      ])
      const json = await summaryRes.json() as DashboardData & { error?: string; message?: string }
      if (!summaryRes.ok) {
        if (json.error === 'agent_db_not_migrated') {
          throw new Error('Cost DB migration apply করা হয়নি। Production-এ `npx prisma migrate deploy` চালান।')
        }
        throw new Error(json.message ?? `লোড ব্যর্থ (HTTP ${summaryRes.status})`)
      }
      setData(json)
      setBudgetDaily(json.budgets.dailyUsd != null ? String(json.budgets.dailyUsd) : '')
      setBudgetMonthly(json.budgets.monthlyUsd != null ? String(json.budgets.monthlyUsd) : '')

      if (balanceRes.ok) {
        setBalances(await balanceRes.json() as BalanceData)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'লোড ব্যর্থ')
    } finally {
      setLoading(false)
    }
  }, [])

  async function refreshBalances() {
    setRefreshingBalances(true)
    try {
      const res = await fetch('/api/assistant/costs/balances', { method: 'POST' })
      if (!res.ok) throw new Error('ব্যালেন্স রিফ্রেশ ব্যর্থ')
      setBalances(await res.json() as BalanceData)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'রিফ্রেশ ব্যর্থ')
    } finally {
      setRefreshingBalances(false)
    }
  }

  useEffect(() => { void load() }, [load])

  async function saveBudget() {
    setSavingBudget(true)
    try {
      const res = await fetch('/api/assistant/costs/budget', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dailyUsd: budgetDaily ? parseFloat(budgetDaily) : null,
          monthlyUsd: budgetMonthly ? parseFloat(budgetMonthly) : null,
        }),
      })
      if (!res.ok) throw new Error('সংরক্ষণ ব্যর্থ')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'সংরক্ষণ ব্যর্থ')
    } finally {
      setSavingBudget(false)
    }
  }

  const chartData = (data?.dailyLast30 ?? []).map((d) => ({
    date: String(d.date).slice(5),
    anthropic: Number(d.anthropic ?? 0),
    openai: Number(d.openai ?? 0),
    openrouter: Number(d.openrouter ?? 0),
    gemini: Number(d.gemini ?? 0),
    google_tts: Number(d.google_tts ?? 0),
    elevenlabs: Number(d.elevenlabs ?? 0),
    veo: Number(d.veo ?? 0),
    twilio: Number(d.twilio ?? 0),
    total: Number(d.total ?? 0),
  }))

  // Per-model month list (sorted desc) + the set of model ids that actually have
  // spend, used to drive the stacked daily chart series.
  const byModel = data?.byModel ?? []
  const modelDaily = data?.modelDailyLast30 ?? []
  const modelLabelById = new Map(byModel.map((m) => [m.modelId, m.label]))
  const activeModelIds = byModel.map((m) => m.modelId)
  const modelChartData = modelDaily.map((d) => {
    const row: Record<string, number | string> = { date: String(d.date).slice(5) }
    for (const id of activeModelIds) row[id] = Number(d[id] ?? 0)
    row.total = Number(d.total ?? 0)
    return row
  })

  const pieData = (data?.byProvider ?? []).map((p) => ({
    name: PROVIDER_LABELS[p.provider] ?? p.provider,
    providerId: p.provider,
    value: p.totalUsd,
  }))

  if (loading) {
    return (
      <div className="safe-top safe-x mx-auto max-w-5xl space-y-4 p-4 pb-[max(16px,env(safe-area-inset-bottom))] md:p-6 bg-transparent min-h-[100dvh]">
        <div className="skeleton h-8 w-48 rounded-lg" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-24 rounded-2xl" />
          ))}
        </div>
        <div className="skeleton h-56 rounded-2xl" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex min-h-[50dvh] flex-col items-center justify-center gap-3 p-6 text-center bg-transparent">
        <p className="text-sm text-red-500">⚠️ {error ?? 'ডেটা পাওয়া যায়নি'}</p>
        <button onClick={() => void load()} className="rounded-xl border border-border-subtle bg-card/80 px-4 py-2 text-xs text-muted hover:text-cream hover:border-[#E07A5F]/30 shadow-sm transition-all">
          আবার চেষ্টা
        </button>
      </div>
    )
  }

  return (
    <div className="safe-top safe-x mx-auto max-w-5xl space-y-6 p-4 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:p-6 md:pb-6 bg-transparent min-h-[100dvh]">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[18px] alma-frost px-4 py-3">
        <div>
          <h1 className="text-lg font-bold text-cream">AI খরচ <span className="text-[#E07A5F]">ড্যাশবোর্ড</span></h1>
          <p className="text-[11px] text-muted">API + সাবস্ক্রিপশন — এক জায়গায়</p>
        </div>
        <div className="flex gap-2">
          <Link href="/agent" className="rounded-xl border border-border-subtle bg-card/80 px-3 py-2 text-xs text-muted hover:text-cream hover:border-[#E07A5F]/30 shadow-sm transition-all">
            ← চ্যাট
          </Link>
          <a
            href="/api/assistant/costs/export"
            className="rounded-xl bg-[#E07A5F]/10 border border-[#E07A5F]/20 px-3 py-2 text-xs font-semibold text-[#E07A5F] hover:bg-[#E07A5F]/15 hover:shadow-[0_2px_12px_rgba(224,122,95,0.12)] transition-all"
          >
            CSV ডাউনলোড
          </a>
        </div>
      </div>

      {/* API balances */}
      <div className="rounded-[18px] border border-border-subtle bg-card/80 p-4 shadow-card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold text-[#E07A5F]">💳 API ব্যালেন্স</p>
          <div className="flex items-center gap-2">
            {balances?.checkedAt && (
              <p className="text-[10px] text-muted">
                শেষ চেক: {fmtCheckedAt(balances.checkedAt)}
              </p>
            )}
            <button
              onClick={() => void refreshBalances()}
              disabled={refreshingBalances}
              className="rounded-lg border border-border-subtle bg-transparent px-2.5 py-1 text-[10px] text-muted hover:text-cream hover:border-[#E07A5F]/30 disabled:opacity-50 transition-all"
            >
              {refreshingBalances ? 'রিফ্রেশ…' : '🔄 Refresh'}
            </button>
          </div>
        </div>
        {!balances?.providers?.length ? (
          <p className="py-4 text-center text-[11px] text-muted">ব্যালেন্স লোড হচ্ছে…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-[11px]">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className="py-2.5 pr-3 font-medium text-[#E07A5F]">Provider</th>
                  <th className="py-2.5 pr-3 font-medium text-[#E07A5F]">ব্যালেন্স</th>
                  <th className="py-2.5 pr-3 font-medium text-[#E07A5F]">আজ খরচ</th>
                  <th className="py-2.5 pr-3 font-medium text-[#E07A5F]">এই মাসে</th>
                  <th className="py-2.5 font-medium text-[#E07A5F]">সূত্র</th>
                </tr>
              </thead>
              <tbody>
                {balances.providers.map((row) => (
                  <tr key={row.id} className="border-b border-border-subtle last:border-0 hover:bg-white/[0.04] transition-colors">
                    <td className="py-2.5 pr-3 text-cream">{row.label}</td>
                    <td className={cn('py-2.5 pr-3 font-medium', balanceColor(row))}>
                      {fmtBalanceCell(row)}
                      {row.free && (
                        <span className="ml-1.5 inline-flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[9px] text-emerald-600">
                          Free
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-muted">{fmtSpendCell(row.todayUsd, row.id)}</td>
                    <td className="py-2.5 pr-3 text-muted">{fmtSpendCell(row.monthUsd, row.id)}</td>
                    <td className="py-2.5 text-muted">{row.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(data.googleTts || data.elevenLabs) && (
        <div className="space-y-3">
          <p className="text-[11px] font-semibold text-muted">🎙️ Voice API — Google TTS vs ElevenLabs (আলাদা হিসাব)</p>
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {data.googleTts && (
              <TtsProviderCard
                title="📞 Google TTS (কল — primary)"
                accent="text-[#8B5CF6]"
                borderClass="border-[#8B5CF6]/25"
                gradientClass="bg-gradient-to-br from-[#8B5CF6]/[0.06] to-white"
                priceNote={data.googleTts.priceNote}
                todayCalls={data.googleTts.today.phoneCalls}
                monthCalls={data.googleTts.month.phoneCalls}
                todayVoice={data.googleTts.today.voiceMessages}
                monthVoice={data.googleTts.month.voiceMessages}
                twilioToday={data.googleTts.twilioCallsToday}
                twilioMonth={data.googleTts.twilioCallsMonth}
              />
            )}
            {data.elevenLabs && (
              <TtsProviderCard
                title="🗣️ ElevenLabs (staff / voice reply)"
                accent="text-[#EC4899]"
                borderClass="border-[#EC4899]/25"
                gradientClass="bg-gradient-to-br from-[#EC4899]/[0.06] to-white"
                priceNote={data.elevenLabs.priceNote}
                todayCalls={data.elevenLabs.today.phoneCalls}
                monthCalls={data.elevenLabs.month.phoneCalls}
                todayVoice={data.elevenLabs.today.voiceMessages}
                monthVoice={data.elevenLabs.month.voiceMessages}
                callLabel="ElevenLabs ফোন কল (বিরল)"
                primaryMode="voice"
              />
            )}
          </div>
        </div>
      )}

      {/* Summary cards */}
      <motion.div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
        variants={staggerContainer}
        initial="hidden"
        animate="show"
      >
        {[
          {
            label: data.todayDhakaDate ? `আজ (Dhaka ${data.todayDhakaDate})` : 'আজ (USD API)',
            value: fmtUsd(data.todayUsd),
            sub: 'Anthropic/Twilio/OpenAI ইত্যাদি — Oxylabs বাদ',
          },
          {
            label: 'Oxylabs আজ',
            value: `${data.todayOxylabsCredits ?? 0} ক্রেডিট`,
            sub: 'Prepaid credit — USD নয়',
          },
          { label: 'এই মাস', value: fmtUsd(data.monthUsd), sub: null },
          { label: 'পূর্বাভাস (মাস)', value: fmtUsd(data.forecastUsd), sub: null },
        ].map((c, idx) => (
          <motion.div
            key={c.label}
            variants={staggerItem}
            className={cn(
              'rounded-[18px] border border-border-subtle bg-card/80 p-4 transition-all hover:border-border shadow-card',
              STAT_GLOWS[idx],
            )}
          >
            <p className="text-[10px] uppercase tracking-wider text-muted">{c.label}</p>
            <p className="mt-1 text-2xl font-bold text-cream">{c.value}</p>
            {c.sub && <p className="mt-1 text-[10px] text-muted">{c.sub}</p>}
          </motion.div>
        ))}
      </motion.div>

      {/* Budget settings */}
      <div className="rounded-[18px] border border-border-subtle bg-card/80 p-4 shadow-card">
        <p className="text-xs font-semibold text-[#E07A5F] mb-3">বাজেট সতর্কতা (USD)</p>
        <div className="flex flex-wrap gap-3 items-end">
          <label className="text-[11px] text-muted">
            দৈনিক
            <input
              type="number"
              step="0.01"
              value={budgetDaily}
              onChange={(e) => setBudgetDaily(e.target.value)}
              className="mt-1 block w-28 rounded-lg bg-transparent border border-border px-2 py-2 text-sm text-cream focus:outline-none focus:border-[#E07A5F]/40 focus:shadow-[0_0_8px_rgba(224,122,95,0.1)] transition-all"
              placeholder="—"
            />
          </label>
          <label className="text-[11px] text-muted">
            মাসিক
            <input
              type="number"
              step="0.01"
              value={budgetMonthly}
              onChange={(e) => setBudgetMonthly(e.target.value)}
              className="mt-1 block w-28 rounded-lg bg-transparent border border-border px-2 py-2 text-sm text-cream focus:outline-none focus:border-[#E07A5F]/40 focus:shadow-[0_0_8px_rgba(224,122,95,0.1)] transition-all"
              placeholder="—"
            />
          </label>
          <button
            onClick={() => void saveBudget()}
            disabled={savingBudget}
            className="rounded-lg bg-[#E07A5F]/10 border border-[#E07A5F]/20 px-3 py-1.5 text-xs text-[#E07A5F] font-semibold disabled:opacity-50 hover:bg-[#E07A5F]/15 hover:shadow-[0_2px_8px_rgba(224,122,95,0.12)] transition-all"
          >
            {savingBudget ? 'সংরক্ষণ…' : 'সংরক্ষণ'}
          </button>
        </div>
        <p className="mt-2 text-[10px] text-muted">৮০% → Tier 1 সতর্কতা | ১০০% → Tier 2 critical</p>
        {(data.dailyBudgetPct != null || data.monthlyBudgetPct != null) && (
          <div className="mt-3 space-y-2 text-[11px]">
            {data.dailyBudgetPct != null && data.budgets.dailyUsd != null && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-muted">
                  <span>আজকের বাজেট ব্যবহার</span>
                  <span className={data.dailyBudgetPct >= 100 ? 'text-red-500' : data.dailyBudgetPct >= 80 ? 'text-amber-600' : 'text-cream'}>
                    {data.dailyBudgetPct}% ({fmtUsd(data.todayUsd)} / {fmtUsd(data.budgets.dailyUsd)})
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.04]">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-500',
                      data.dailyBudgetPct >= 100
                        ? 'bg-gradient-to-r from-red-500 to-red-400'
                        : data.dailyBudgetPct >= 80
                          ? 'bg-gradient-to-r from-amber-500 to-amber-400'
                          : 'bg-gradient-to-r from-[#E07A5F] to-[#D4A84B]',
                    )}
                    style={{ width: `${Math.min(data.dailyBudgetPct, 100)}%` }}
                  />
                </div>
              </div>
            )}
            {data.monthlyBudgetPct != null && data.budgets.monthlyUsd != null && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-muted">
                  <span>মাসিক বাজেট ব্যবহার</span>
                  <span className={data.monthlyBudgetPct >= 100 ? 'text-red-500' : data.monthlyBudgetPct >= 80 ? 'text-amber-600' : 'text-cream'}>
                    {data.monthlyBudgetPct}% ({fmtUsd(data.monthUsd)} / {fmtUsd(data.budgets.monthlyUsd)})
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.04]">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-500',
                      data.monthlyBudgetPct >= 100
                        ? 'bg-gradient-to-r from-red-500 to-red-400'
                        : data.monthlyBudgetPct >= 80
                          ? 'bg-gradient-to-r from-amber-500 to-amber-400'
                          : 'bg-gradient-to-r from-[#E07A5F] to-[#D4A84B]',
                    )}
                    style={{ width: `${Math.min(data.monthlyBudgetPct, 100)}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-[18px] border border-border-subtle bg-card/80 p-4 shadow-card">
          <p className="text-xs font-semibold text-muted mb-3">দৈনিক খরচ (৩০ দিন)</p>
          {chartData.length === 0 ? (
            <p className="py-12 text-center text-[11px] text-muted">এখনো কোনো ইভেন্ট নেই</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData}>
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={{ stroke: 'rgba(0,0,0,0.06)' }} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={{ stroke: 'rgba(0,0,0,0.06)' }} tickLine={false} tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  formatter={(v: number) => fmtUsd(v)}
                  contentStyle={{ backgroundColor: '#FFFFFF', border: '1px solid rgba(0,0,0,0.06)', borderRadius: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}
                  labelStyle={{ color: '#1a1a2e' }}
                  itemStyle={{ color: '#64748b' }}
                />
                <Bar dataKey="anthropic" stackId="a" fill={PROVIDER_COLORS.anthropic} radius={[0, 0, 0, 0]} />
                <Bar dataKey="openai" stackId="a" fill={PROVIDER_COLORS.openai} />
                <Bar dataKey="openrouter" stackId="a" fill={PROVIDER_COLORS.openrouter} />
                <Bar dataKey="gemini" stackId="a" fill={PROVIDER_COLORS.gemini} />
                <Bar dataKey="google_tts" stackId="a" fill={PROVIDER_COLORS.google_tts} />
                <Bar dataKey="elevenlabs" stackId="a" fill={PROVIDER_COLORS.elevenlabs} />
                <Bar dataKey="veo" stackId="a" fill={PROVIDER_COLORS.veo} />
                <Bar dataKey="twilio" stackId="a" fill={PROVIDER_COLORS.twilio} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="rounded-[18px] border border-border-subtle bg-card/80 p-4 shadow-card">
          <p className="text-xs font-semibold text-muted mb-3">প্রোভাইডার (এই মাস)</p>
          {pieData.length === 0 ? (
            <p className="py-12 text-center text-[11px] text-muted">ডেটা নেই</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({ name }) => name}>
                  {pieData.map((e) => (
                    <Cell key={e.name} fill={PROVIDER_COLORS[e.providerId] ?? '#94a3b8'} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(v: number) => fmtUsd(v)}
                  contentStyle={{ backgroundColor: '#FFFFFF', border: '1px solid rgba(0,0,0,0.06)', borderRadius: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}
                  labelStyle={{ color: '#1a1a2e' }}
                  itemStyle={{ color: '#64748b' }}
                />
                <Legend wrapperStyle={{ fontSize: 10, color: '#64748b' }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Per-model breakdown — every model, end-to-end: today + month totals, with
          a 30-day stacked daily chart so the owner sees which model cost what, which day. */}
      {byModel.length > 0 && (
        <div className="rounded-[18px] border border-border-subtle bg-card/80 p-4 shadow-card">
          <p className="text-xs font-semibold text-[#E07A5F] mb-1">🤖 মডেল অনুযায়ী খরচ (প্রতিটি API key আলাদা)</p>
          <p className="text-[10px] text-muted mb-3">কোন মডেল কত খরচ করল — আজ ও এই মাসে, এবং কোন দিন কত (নিচের চার্ট)</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-[11px]">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className="py-2.5 pr-3 font-medium text-[#E07A5F]">মডেল</th>
                  <th className="py-2.5 pr-3 font-medium text-[#E07A5F]">প্রোভাইডার</th>
                  <th className="py-2.5 pr-3 font-medium text-[#E07A5F] text-right">আজ</th>
                  <th className="py-2.5 font-medium text-[#E07A5F] text-right">এই মাসে</th>
                </tr>
              </thead>
              <tbody>
                {byModel.map((m, idx) => (
                  <tr key={m.modelId} className="border-b border-border-subtle last:border-0 hover:bg-white/[0.04] transition-colors">
                    <td className="py-2.5 pr-3 text-cream">
                      <span className="inline-flex items-center gap-2">
                        <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: MODEL_CHART_COLORS[idx % MODEL_CHART_COLORS.length] }} />
                        {m.label}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-muted">{PROVIDER_LABELS[m.provider] ?? m.provider}</td>
                    <td className="py-2.5 pr-3 text-right text-muted tabular-nums">{fmtUsd(m.todayUsd)}</td>
                    <td className="py-2.5 text-right text-[#E07A5F] font-medium tabular-nums">{fmtUsd(m.monthUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {modelChartData.length > 0 && (
            <div className="mt-4">
              <p className="text-[10px] text-muted mb-2">দৈনিক খরচ — মডেল অনুযায়ী (৩০ দিন)</p>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={modelChartData}>
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={{ stroke: 'rgba(0,0,0,0.06)' }} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={{ stroke: 'rgba(0,0,0,0.06)' }} tickLine={false} tickFormatter={(v) => `$${v}`} />
                  <Tooltip
                    formatter={(v: number, name: string) => [fmtUsd(v), modelLabelById.get(name) ?? name]}
                    contentStyle={{ backgroundColor: '#FFFFFF', border: '1px solid rgba(0,0,0,0.06)', borderRadius: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}
                    labelStyle={{ color: '#1a1a2e' }}
                    itemStyle={{ color: '#64748b' }}
                  />
                  {activeModelIds.map((id, idx) => (
                    <Bar
                      key={id}
                      dataKey={id}
                      stackId="m"
                      fill={MODEL_CHART_COLORS[idx % MODEL_CHART_COLORS.length]}
                      radius={idx === activeModelIds.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* Top conversations */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-[18px] border border-border-subtle bg-card/80 p-4 shadow-card">
          <p className="text-xs font-semibold text-muted mb-3">🌐 Web — সবচেয়ে ব্যয়বহুল কথোপকথন</p>
          {data.topConversations.length === 0 ? (
            <p className="text-[11px] text-muted py-4 text-center">এখনো নেই</p>
          ) : (
            <ul className="space-y-2">
              {data.topConversations.map((c) => (
                <li key={c.conversationId} className="flex items-center justify-between gap-2 text-xs rounded-lg px-2 py-1.5 hover:bg-white/[0.04] transition-colors">
                  <Link href="/agent" className="truncate text-muted hover:text-[#E07A5F] transition-colors">
                    {c.title ?? c.conversationId.slice(0, 8)}
                  </Link>
                  <span className="shrink-0 text-[#E07A5F] font-medium">{fmtUsd(c.totalUsd)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-[18px] border border-border-subtle bg-card/80 p-4 shadow-card">
          <p className="text-xs font-semibold text-muted mb-1">📱 Telegram — কথোপকথন খরচ (শীর্ষ)</p>
          <p className="text-[10px] text-muted mb-3">
            আজ {fmtUsd(data.telegramTodayUsd)} · এই মাসে {fmtUsd(data.telegramMonthUsd)}
          </p>
          {data.topTelegramConversations.length === 0 ? (
            <p className="text-[11px] text-muted py-4 text-center">
              এখনো Telegram ট্যাগ করা কথোপকথন নেই — নতুন মেসেজ থেকে ট্র্যাক হবে
            </p>
          ) : (
            <ul className="space-y-2">
              {data.topTelegramConversations.map((c) => (
                <li key={c.conversationId} className="flex items-center justify-between gap-2 text-xs rounded-lg px-2 py-1.5 hover:bg-white/[0.04] transition-colors">
                  <span className="truncate text-muted">{c.title ?? c.conversationId.slice(0, 8)}</span>
                  <span className="shrink-0 text-[#E07A5F] font-medium">{fmtUsd(c.totalUsd)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Telegram daily chart */}
      {(data.telegramDailyLast30?.length ?? 0) > 0 && (
        <div className="rounded-[18px] border border-border-subtle bg-card/80 p-4 shadow-card">
          <p className="text-xs font-semibold text-muted mb-3">📱 Telegram — দৈনিক খরচ (৩০ দিন)</p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={data.telegramDailyLast30.map((d) => ({
              date: d.date.slice(5),
              total: d.totalUsd,
            }))}>
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={{ stroke: 'rgba(0,0,0,0.06)' }} tickLine={false} />
              <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={{ stroke: 'rgba(0,0,0,0.06)' }} tickLine={false} tickFormatter={(v) => `$${v}`} />
              <Tooltip
                formatter={(v: number) => fmtUsd(v)}
                contentStyle={{ backgroundColor: '#FFFFFF', border: '1px solid rgba(0,0,0,0.06)', borderRadius: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}
                labelStyle={{ color: '#1a1a2e' }}
                itemStyle={{ color: '#64748b' }}
              />
              <Bar dataKey="total" fill="#81B29A" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Subscriptions */}
      <div className="rounded-[18px] border border-border-subtle bg-card/80 p-4 shadow-card">
        <p className="text-xs font-semibold text-muted mb-3">সাবস্ক্রিপশন</p>
        {data.subscriptions.length === 0 ? (
          <p className="text-[11px] text-muted py-4 text-center">
            কোনো সাবস্ক্রিপশন নেই — এজেন্টকে বলুন: &quot;ChatGPT subscription add koro…&quot;
          </p>
        ) : (
          <ul className="space-y-2">
            {data.subscriptions.map((s) => {
              const badge = renewalBadge(s.nextRenewalAt)
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border-subtle bg-transparent px-3 py-2.5 hover:bg-card/80 hover:shadow-sm transition-all">
                  <div>
                    <p className="text-xs font-medium text-cream">{s.name}</p>
                    <p className="text-[10px] text-muted">
                      {s.currency} {s.amount}/{s.billingCycle === 'yearly' ? 'বছর' : 'মাস'}
                      {s.category ? ` · ${s.category}` : ''}
                    </p>
                  </div>
                  <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', badge.cls)}>
                    {badge.label}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
