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
  gemini: '#3B82F6',
  google_tts: '#8B5CF6',
  twilio: '#D4A84B',
  elevenlabs: '#EC4899',
  veo: '#0EA5E9',
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  google_tts: 'Google TTS',
  twilio: 'Twilio',
  elevenlabs: 'ElevenLabs',
  veo: 'VEO 3',
  oxylabs: 'Oxylabs',
}

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
  return { label: `${days} দিন`, cls: 'bg-[#FAF9F6] border border-black/[0.06] text-[#94a3b8]' }
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
  if (row.balanceUsd == null) return 'text-[#94a3b8]'
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
    gemini: Number(d.gemini ?? 0),
    google_tts: Number(d.google_tts ?? 0),
    elevenlabs: Number(d.elevenlabs ?? 0),
    veo: Number(d.veo ?? 0),
    twilio: Number(d.twilio ?? 0),
    total: Number(d.total ?? 0),
  }))

  const pieData = (data?.byProvider ?? []).map((p) => ({
    name: PROVIDER_LABELS[p.provider] ?? p.provider,
    providerId: p.provider,
    value: p.totalUsd,
  }))

  if (loading) {
    return (
      <div className="safe-top safe-x mx-auto max-w-5xl space-y-4 p-4 pb-[max(16px,env(safe-area-inset-bottom))] md:p-6 bg-[#FAF9F6] min-h-screen">
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
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-6 text-center bg-[#FAF9F6]">
        <p className="text-sm text-red-500">⚠️ {error ?? 'ডেটা পাওয়া যায়নি'}</p>
        <button onClick={() => void load()} className="rounded-xl border border-black/[0.06] bg-white px-4 py-2 text-xs text-[#64748b] hover:text-[#1a1a2e] hover:border-[#E07A5F]/30 shadow-sm transition-all">
          আবার চেষ্টা
        </button>
      </div>
    )
  }

  return (
    <div className="safe-top safe-x mx-auto max-w-5xl space-y-6 p-4 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:p-6 md:pb-6 bg-[#FAF9F6] min-h-screen">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-black/[0.06] bg-white px-4 py-3 shadow-sm">
        <div>
          <h1 className="text-lg font-bold text-[#1a1a2e]">AI খরচ <span className="text-[#E07A5F]">ড্যাশবোর্ড</span></h1>
          <p className="text-[11px] text-[#94a3b8]">API + সাবস্ক্রিপশন — এক জায়গায়</p>
        </div>
        <div className="flex gap-2">
          <Link href="/agent" className="rounded-xl border border-black/[0.06] bg-white px-3 py-2 text-xs text-[#64748b] hover:text-[#1a1a2e] hover:border-[#E07A5F]/30 shadow-sm transition-all">
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
      <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold text-[#E07A5F]">💳 API ব্যালেন্স</p>
          <div className="flex items-center gap-2">
            {balances?.checkedAt && (
              <p className="text-[10px] text-[#94a3b8]">
                শেষ চেক: {fmtCheckedAt(balances.checkedAt)}
              </p>
            )}
            <button
              onClick={() => void refreshBalances()}
              disabled={refreshingBalances}
              className="rounded-lg border border-black/[0.06] bg-[#FAF9F6] px-2.5 py-1 text-[10px] text-[#64748b] hover:text-[#1a1a2e] hover:border-[#E07A5F]/30 disabled:opacity-50 transition-all"
            >
              {refreshingBalances ? 'রিফ্রেশ…' : '🔄 Refresh'}
            </button>
          </div>
        </div>
        {!balances?.providers?.length ? (
          <p className="py-4 text-center text-[11px] text-[#94a3b8]">ব্যালেন্স লোড হচ্ছে…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-[11px]">
              <thead>
                <tr className="border-b border-black/[0.06]">
                  <th className="py-2.5 pr-3 font-medium text-[#E07A5F]">Provider</th>
                  <th className="py-2.5 pr-3 font-medium text-[#E07A5F]">ব্যালেন্স</th>
                  <th className="py-2.5 pr-3 font-medium text-[#E07A5F]">আজ খরচ</th>
                  <th className="py-2.5 pr-3 font-medium text-[#E07A5F]">এই মাসে</th>
                  <th className="py-2.5 font-medium text-[#E07A5F]">সূত্র</th>
                </tr>
              </thead>
              <tbody>
                {balances.providers.map((row) => (
                  <tr key={row.id} className="border-b border-black/[0.04] last:border-0 hover:bg-[#FAF9F6] transition-colors">
                    <td className="py-2.5 pr-3 text-[#1a1a2e]">{row.label}</td>
                    <td className={cn('py-2.5 pr-3 font-medium', balanceColor(row))}>
                      {fmtBalanceCell(row)}
                      {row.free && (
                        <span className="ml-1.5 inline-flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[9px] text-emerald-600">
                          Free
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-[#64748b]">{fmtSpendCell(row.todayUsd, row.id)}</td>
                    <td className="py-2.5 pr-3 text-[#64748b]">{fmtSpendCell(row.monthUsd, row.id)}</td>
                    <td className="py-2.5 text-[#94a3b8]">{row.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

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
              'rounded-2xl border border-black/[0.06] bg-white p-4 transition-all hover:border-black/[0.1] shadow-sm',
              STAT_GLOWS[idx],
            )}
          >
            <p className="text-[10px] uppercase tracking-wider text-[#94a3b8]">{c.label}</p>
            <p className="mt-1 text-2xl font-bold text-[#1a1a2e]">{c.value}</p>
            {c.sub && <p className="mt-1 text-[10px] text-[#94a3b8]">{c.sub}</p>}
          </motion.div>
        ))}
      </motion.div>

      {/* Budget settings */}
      <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm">
        <p className="text-xs font-semibold text-[#E07A5F] mb-3">বাজেট সতর্কতা (USD)</p>
        <div className="flex flex-wrap gap-3 items-end">
          <label className="text-[11px] text-[#94a3b8]">
            দৈনিক
            <input
              type="number"
              step="0.01"
              value={budgetDaily}
              onChange={(e) => setBudgetDaily(e.target.value)}
              className="mt-1 block w-28 rounded-lg bg-[#FAF9F6] border border-black/[0.08] px-2 py-1.5 text-xs text-[#1a1a2e] focus:outline-none focus:border-[#E07A5F]/40 focus:shadow-[0_0_8px_rgba(224,122,95,0.1)] transition-all"
              placeholder="—"
            />
          </label>
          <label className="text-[11px] text-[#94a3b8]">
            মাসিক
            <input
              type="number"
              step="0.01"
              value={budgetMonthly}
              onChange={(e) => setBudgetMonthly(e.target.value)}
              className="mt-1 block w-28 rounded-lg bg-[#FAF9F6] border border-black/[0.08] px-2 py-1.5 text-xs text-[#1a1a2e] focus:outline-none focus:border-[#E07A5F]/40 focus:shadow-[0_0_8px_rgba(224,122,95,0.1)] transition-all"
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
        <p className="mt-2 text-[10px] text-[#94a3b8]">৮০% → Tier 1 সতর্কতা | ১০০% → Tier 2 critical</p>
        {(data.dailyBudgetPct != null || data.monthlyBudgetPct != null) && (
          <div className="mt-3 space-y-2 text-[11px]">
            {data.dailyBudgetPct != null && data.budgets.dailyUsd != null && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[#64748b]">
                  <span>আজকের বাজেট ব্যবহার</span>
                  <span className={data.dailyBudgetPct >= 100 ? 'text-red-500' : data.dailyBudgetPct >= 80 ? 'text-amber-600' : 'text-[#1a1a2e]'}>
                    {data.dailyBudgetPct}% ({fmtUsd(data.todayUsd)} / {fmtUsd(data.budgets.dailyUsd)})
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.04]">
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
                <div className="flex items-center justify-between text-[#64748b]">
                  <span>মাসিক বাজেট ব্যবহার</span>
                  <span className={data.monthlyBudgetPct >= 100 ? 'text-red-500' : data.monthlyBudgetPct >= 80 ? 'text-amber-600' : 'text-[#1a1a2e]'}>
                    {data.monthlyBudgetPct}% ({fmtUsd(data.monthUsd)} / {fmtUsd(data.budgets.monthlyUsd)})
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.04]">
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
        <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold text-[#64748b] mb-3">দৈনিক খরচ (৩০ দিন)</p>
          {chartData.length === 0 ? (
            <p className="py-12 text-center text-[11px] text-[#94a3b8]">এখনো কোনো ইভেন্ট নেই</p>
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
                <Bar dataKey="gemini" stackId="a" fill={PROVIDER_COLORS.gemini} />
                <Bar dataKey="google_tts" stackId="a" fill={PROVIDER_COLORS.google_tts} />
                <Bar dataKey="elevenlabs" stackId="a" fill={PROVIDER_COLORS.elevenlabs} />
                <Bar dataKey="veo" stackId="a" fill={PROVIDER_COLORS.veo} />
                <Bar dataKey="twilio" stackId="a" fill={PROVIDER_COLORS.twilio} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold text-[#64748b] mb-3">প্রোভাইডার (এই মাস)</p>
          {pieData.length === 0 ? (
            <p className="py-12 text-center text-[11px] text-[#94a3b8]">ডেটা নেই</p>
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

      {/* Top conversations */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold text-[#64748b] mb-3">🌐 Web — সবচেয়ে ব্যয়বহুল কথোপকথন</p>
          {data.topConversations.length === 0 ? (
            <p className="text-[11px] text-[#94a3b8] py-4 text-center">এখনো নেই</p>
          ) : (
            <ul className="space-y-2">
              {data.topConversations.map((c) => (
                <li key={c.conversationId} className="flex items-center justify-between gap-2 text-xs rounded-lg px-2 py-1.5 hover:bg-[#FAF9F6] transition-colors">
                  <Link href="/agent" className="truncate text-[#64748b] hover:text-[#E07A5F] transition-colors">
                    {c.title ?? c.conversationId.slice(0, 8)}
                  </Link>
                  <span className="shrink-0 text-[#E07A5F] font-medium">{fmtUsd(c.totalUsd)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold text-[#64748b] mb-1">📱 Telegram — কথোপকথন খরচ (শীর্ষ)</p>
          <p className="text-[10px] text-[#94a3b8] mb-3">
            আজ {fmtUsd(data.telegramTodayUsd)} · এই মাসে {fmtUsd(data.telegramMonthUsd)}
          </p>
          {data.topTelegramConversations.length === 0 ? (
            <p className="text-[11px] text-[#94a3b8] py-4 text-center">
              এখনো Telegram ট্যাগ করা কথোপকথন নেই — নতুন মেসেজ থেকে ট্র্যাক হবে
            </p>
          ) : (
            <ul className="space-y-2">
              {data.topTelegramConversations.map((c) => (
                <li key={c.conversationId} className="flex items-center justify-between gap-2 text-xs rounded-lg px-2 py-1.5 hover:bg-[#FAF9F6] transition-colors">
                  <span className="truncate text-[#64748b]">{c.title ?? c.conversationId.slice(0, 8)}</span>
                  <span className="shrink-0 text-[#E07A5F] font-medium">{fmtUsd(c.totalUsd)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Telegram daily chart */}
      {(data.telegramDailyLast30?.length ?? 0) > 0 && (
        <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold text-[#64748b] mb-3">📱 Telegram — দৈনিক খরচ (৩০ দিন)</p>
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
      <div className="rounded-2xl border border-black/[0.06] bg-white p-4 shadow-sm">
        <p className="text-xs font-semibold text-[#64748b] mb-3">সাবস্ক্রিপশন</p>
        {data.subscriptions.length === 0 ? (
          <p className="text-[11px] text-[#94a3b8] py-4 text-center">
            কোনো সাবস্ক্রিপশন নেই — এজেন্টকে বলুন: &quot;ChatGPT subscription add koro…&quot;
          </p>
        ) : (
          <ul className="space-y-2">
            {data.subscriptions.map((s) => {
              const badge = renewalBadge(s.nextRenewalAt)
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-black/[0.06] bg-[#FAF9F6] px-3 py-2.5 hover:bg-white hover:shadow-sm transition-all">
                  <div>
                    <p className="text-xs font-medium text-[#1a1a2e]">{s.name}</p>
                    <p className="text-[10px] text-[#94a3b8]">
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
