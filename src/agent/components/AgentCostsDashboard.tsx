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
  anthropic: '#C9A84C',
  openai: '#10B981',
  gemini: '#3B82F6',
  google_tts: '#8B5CF6',
  twilio: '#F59E0B',
  elevenlabs: '#EC4899',
}

function fmtUsd(n: number) {
  return `$${n.toFixed(n < 0.01 && n > 0 ? 4 : 2)}`
}

function renewalBadge(dateStr: string) {
  const today = new Date()
  const renewal = new Date(dateStr + 'T00:00:00')
  const days = Math.ceil((renewal.getTime() - today.getTime()) / 86400000)
  if (days < 0) return { label: 'মেয়াদোত্তীর্ণ', cls: 'bg-red-500/15 border border-red-500/30 text-red-300 shadow-[0_0_8px_rgba(239,68,68,0.1)]' }
  if (days <= 3) return { label: `${days} দিন`, cls: 'bg-amber-500/15 border border-amber-500/30 text-amber-200 shadow-[0_0_8px_rgba(245,158,11,0.1)]' }
  if (days <= 14) return { label: `${days} দিন`, cls: 'bg-[#C9A84C]/10 border border-[#C9A84C]/25 text-[#E8C96A]' }
  return { label: `${days} দিন`, cls: 'bg-white/5 border border-white/[0.08] text-[#6B6B72]' }
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
  if (row.free) return 'text-emerald-300'
  if (row.balanceUsd == null) return 'text-[#6B6B72]'
  if (row.balanceUsd < 1) return 'text-red-300'
  if (row.balanceUsd < 5) return 'text-amber-300'
  return 'text-emerald-300'
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
  'shadow-[0_0_24px_rgba(201,168,76,0.08)]',
  'shadow-[0_0_24px_rgba(201,168,76,0.06)]',
  'shadow-[0_0_24px_rgba(59,130,246,0.08)]',
  'shadow-[0_0_24px_rgba(139,92,246,0.08)]',
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
    twilio: Number(d.twilio ?? 0),
    total: Number(d.total ?? 0),
  }))

  const pieData = (data?.byProvider ?? []).map((p) => ({
    name: p.provider,
    value: p.totalUsd,
  }))

  if (loading) {
    return (
      <div className="safe-top safe-x mx-auto max-w-5xl space-y-4 p-4 pb-[max(16px,env(safe-area-inset-bottom))] md:p-6">
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
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-red-400">⚠️ {error ?? 'ডেটা পাওয়া যায়নি'}</p>
        <button onClick={() => void load()} className="rounded-xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-sm px-4 py-2 text-xs text-[#9B9BA4] hover:text-[#FAFAF8] hover:border-[#C9A84C]/20 transition-all">
          আবার চেষ্টা
        </button>
      </div>
    )
  }

  return (
    <div className="safe-top safe-x mx-auto max-w-5xl space-y-6 p-4 pb-[max(16px,env(safe-area-inset-bottom))] md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-md px-4 py-3">
        <div>
          <h1 className="text-lg font-bold text-[#FAFAF8]">AI খরচ <span className="text-[#C9A84C]">ড্যাশবোর্ড</span></h1>
          <p className="text-[11px] text-[#6B6B72]">API + সাবস্ক্রিপশন — এক জায়গায়</p>
        </div>
        <div className="flex gap-2">
          <Link href="/agent" className="rounded-xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-sm px-3 py-2 text-xs text-[#9B9BA4] hover:text-[#FAFAF8] hover:border-[#C9A84C]/20 transition-all">
            ← চ্যাট
          </Link>
          <a
            href="/api/assistant/costs/export"
            className="rounded-xl bg-[#C9A84C]/[0.08] border border-[#C9A84C]/25 backdrop-blur-sm px-3 py-2 text-xs font-semibold text-[#E8C96A] hover:bg-[#C9A84C]/15 hover:shadow-[0_0_12px_rgba(201,168,76,0.1)] transition-all"
          >
            CSV ডাউনলোড
          </a>
        </div>
      </div>

      {/* API balances */}
      <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-md p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold text-[#E8C96A]">💳 API ব্যালেন্স</p>
          <div className="flex items-center gap-2">
            {balances?.checkedAt && (
              <p className="text-[10px] text-[#6B6B72]">
                শেষ চেক: {fmtCheckedAt(balances.checkedAt)}
              </p>
            )}
            <button
              onClick={() => void refreshBalances()}
              disabled={refreshingBalances}
              className="rounded-lg border border-white/[0.08] bg-white/[0.03] backdrop-blur-sm px-2.5 py-1 text-[10px] text-[#9B9BA4] hover:text-[#FAFAF8] hover:border-[#C9A84C]/20 disabled:opacity-50 transition-all"
            >
              {refreshingBalances ? 'রিফ্রেশ…' : '🔄 Refresh'}
            </button>
          </div>
        </div>
        {!balances?.providers?.length ? (
          <p className="py-4 text-center text-[11px] text-[#6B6B72]">ব্যালেন্স লোড হচ্ছে…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-[11px]">
              <thead>
                <tr className="border-b border-white/[0.08]">
                  <th className="py-2.5 pr-3 font-medium text-[#C9A84C]">Provider</th>
                  <th className="py-2.5 pr-3 font-medium text-[#C9A84C]">ব্যালেন্স</th>
                  <th className="py-2.5 pr-3 font-medium text-[#C9A84C]">আজ খরচ</th>
                  <th className="py-2.5 pr-3 font-medium text-[#C9A84C]">এই মাসে</th>
                  <th className="py-2.5 font-medium text-[#C9A84C]">সূত্র</th>
                </tr>
              </thead>
              <tbody>
                {balances.providers.map((row) => (
                  <tr key={row.id} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] transition-colors">
                    <td className="py-2.5 pr-3 text-[#FAFAF8]">{row.label}</td>
                    <td className={cn('py-2.5 pr-3 font-medium', balanceColor(row))}>
                      {fmtBalanceCell(row)}
                      {row.free && (
                        <span className="ml-1.5 inline-flex items-center rounded-md border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-300">
                          Free
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-[#9B9BA4]">{fmtSpendCell(row.todayUsd, row.id)}</td>
                    <td className="py-2.5 pr-3 text-[#9B9BA4]">{fmtSpendCell(row.monthUsd, row.id)}</td>
                    <td className="py-2.5 text-[#6B6B72]">{row.source}</td>
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
              'rounded-2xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-md p-4 transition-all hover:border-white/[0.12]',
              STAT_GLOWS[idx],
            )}
          >
            <p className="text-[10px] uppercase tracking-wider text-[#6B6B72]">{c.label}</p>
            <p className="mt-1 text-2xl font-bold text-[#FAFAF8]">{c.value}</p>
            {c.sub && <p className="mt-1 text-[10px] text-[#6B6B72]/70">{c.sub}</p>}
          </motion.div>
        ))}
      </motion.div>

      {/* Budget settings */}
      <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-md p-4">
        <p className="text-xs font-semibold text-[#E8C96A] mb-3">বাজেট সতর্কতা (USD)</p>
        <div className="flex flex-wrap gap-3 items-end">
          <label className="text-[11px] text-[#6B6B72]">
            দৈনিক
            <input
              type="number"
              step="0.01"
              value={budgetDaily}
              onChange={(e) => setBudgetDaily(e.target.value)}
              className="mt-1 block w-28 rounded-lg bg-white/[0.03] border border-white/[0.1] backdrop-blur-sm px-2 py-1.5 text-xs text-[#FAFAF8] focus:outline-none focus:border-[#C9A84C]/40 focus:shadow-[0_0_12px_rgba(201,168,76,0.1)] transition-all"
              placeholder="—"
            />
          </label>
          <label className="text-[11px] text-[#6B6B72]">
            মাসিক
            <input
              type="number"
              step="0.01"
              value={budgetMonthly}
              onChange={(e) => setBudgetMonthly(e.target.value)}
              className="mt-1 block w-28 rounded-lg bg-white/[0.03] border border-white/[0.1] backdrop-blur-sm px-2 py-1.5 text-xs text-[#FAFAF8] focus:outline-none focus:border-[#C9A84C]/40 focus:shadow-[0_0_12px_rgba(201,168,76,0.1)] transition-all"
              placeholder="—"
            />
          </label>
          <button
            onClick={() => void saveBudget()}
            disabled={savingBudget}
            className="rounded-lg bg-[#C9A84C]/10 border border-[#C9A84C]/30 backdrop-blur-sm px-3 py-1.5 text-xs text-[#E8C96A] font-semibold disabled:opacity-50 hover:bg-[#C9A84C]/15 hover:shadow-[0_0_12px_rgba(201,168,76,0.1)] transition-all"
          >
            {savingBudget ? 'সংরক্ষণ…' : 'সংরক্ষণ'}
          </button>
        </div>
        <p className="mt-2 text-[10px] text-[#6B6B72]/70">৮০% → Tier 1 সতর্কতা | ১০০% → Tier 2 critical</p>
        {(data.dailyBudgetPct != null || data.monthlyBudgetPct != null) && (
          <div className="mt-3 space-y-2 text-[11px]">
            {data.dailyBudgetPct != null && data.budgets.dailyUsd != null && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[#9B9BA4]">
                  <span>আজকের বাজেট ব্যবহার</span>
                  <span className={data.dailyBudgetPct >= 100 ? 'text-red-300' : data.dailyBudgetPct >= 80 ? 'text-amber-200' : 'text-[#FAFAF8]'}>
                    {data.dailyBudgetPct}% ({fmtUsd(data.todayUsd)} / {fmtUsd(data.budgets.dailyUsd)})
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-500',
                      data.dailyBudgetPct >= 100
                        ? 'bg-gradient-to-r from-red-600 to-red-400'
                        : data.dailyBudgetPct >= 80
                          ? 'bg-gradient-to-r from-amber-600 to-amber-400'
                          : 'bg-gradient-to-r from-[#8B6914] to-[#E8C96A]',
                    )}
                    style={{ width: `${Math.min(data.dailyBudgetPct, 100)}%` }}
                  />
                </div>
              </div>
            )}
            {data.monthlyBudgetPct != null && data.budgets.monthlyUsd != null && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[#9B9BA4]">
                  <span>মাসিক বাজেট ব্যবহার</span>
                  <span className={data.monthlyBudgetPct >= 100 ? 'text-red-300' : data.monthlyBudgetPct >= 80 ? 'text-amber-200' : 'text-[#FAFAF8]'}>
                    {data.monthlyBudgetPct}% ({fmtUsd(data.monthUsd)} / {fmtUsd(data.budgets.monthlyUsd)})
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-500',
                      data.monthlyBudgetPct >= 100
                        ? 'bg-gradient-to-r from-red-600 to-red-400'
                        : data.monthlyBudgetPct >= 80
                          ? 'bg-gradient-to-r from-amber-600 to-amber-400'
                          : 'bg-gradient-to-r from-[#8B6914] to-[#E8C96A]',
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
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-md p-4">
          <p className="text-xs font-semibold text-[#9B9BA4] mb-3">দৈনিক খরচ (৩০ দিন)</p>
          {chartData.length === 0 ? (
            <p className="py-12 text-center text-[11px] text-[#6B6B72]">এখনো কোনো ইভেন্ট নেই</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData}>
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#6B6B72' }} axisLine={{ stroke: '#1E1E24' }} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: '#6B6B72' }} axisLine={{ stroke: '#1E1E24' }} tickLine={false} tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  formatter={(v: number) => fmtUsd(v)}
                  contentStyle={{ backgroundColor: 'rgba(20,20,24,0.95)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', backdropFilter: 'blur(12px)' }}
                  labelStyle={{ color: '#FAFAF8' }}
                  itemStyle={{ color: '#9B9BA4' }}
                />
                <Bar dataKey="anthropic" stackId="a" fill={PROVIDER_COLORS.anthropic} radius={[0, 0, 0, 0]} />
                <Bar dataKey="openai" stackId="a" fill={PROVIDER_COLORS.openai} />
                <Bar dataKey="gemini" stackId="a" fill={PROVIDER_COLORS.gemini} />
                <Bar dataKey="google_tts" stackId="a" fill={PROVIDER_COLORS.google_tts} />
                <Bar dataKey="twilio" stackId="a" fill={PROVIDER_COLORS.twilio} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-md p-4">
          <p className="text-xs font-semibold text-[#9B9BA4] mb-3">প্রোভাইডার (এই মাস)</p>
          {pieData.length === 0 ? (
            <p className="py-12 text-center text-[11px] text-[#6B6B72]">ডেটা নেই</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({ name }) => name}>
                  {pieData.map((e) => (
                    <Cell key={e.name} fill={PROVIDER_COLORS[e.name] ?? '#52525b'} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(v: number) => fmtUsd(v)}
                  contentStyle={{ backgroundColor: 'rgba(20,20,24,0.95)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', backdropFilter: 'blur(12px)' }}
                  labelStyle={{ color: '#FAFAF8' }}
                  itemStyle={{ color: '#9B9BA4' }}
                />
                <Legend wrapperStyle={{ fontSize: 10, color: '#9B9BA4' }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Top conversations */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-md p-4">
          <p className="text-xs font-semibold text-[#9B9BA4] mb-3">🌐 Web — সবচেয়ে ব্যয়বহুল কথোপকথন</p>
          {data.topConversations.length === 0 ? (
            <p className="text-[11px] text-[#6B6B72] py-4 text-center">এখনো নেই</p>
          ) : (
            <ul className="space-y-2">
              {data.topConversations.map((c) => (
                <li key={c.conversationId} className="flex items-center justify-between gap-2 text-xs rounded-lg px-2 py-1.5 hover:bg-white/[0.03] transition-colors">
                  <Link href="/agent" className="truncate text-[#9B9BA4] hover:text-[#E8C96A] transition-colors">
                    {c.title ?? c.conversationId.slice(0, 8)}
                  </Link>
                  <span className="shrink-0 text-[#C9A84C] font-medium">{fmtUsd(c.totalUsd)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-md p-4">
          <p className="text-xs font-semibold text-[#9B9BA4] mb-1">📱 Telegram — কথোপকথন খরচ (শীর্ষ)</p>
          <p className="text-[10px] text-[#6B6B72] mb-3">
            আজ {fmtUsd(data.telegramTodayUsd)} · এই মাসে {fmtUsd(data.telegramMonthUsd)}
          </p>
          {data.topTelegramConversations.length === 0 ? (
            <p className="text-[11px] text-[#6B6B72] py-4 text-center">
              এখনো Telegram ট্যাগ করা কথোপকথন নেই — নতুন মেসেজ থেকে ট্র্যাক হবে
            </p>
          ) : (
            <ul className="space-y-2">
              {data.topTelegramConversations.map((c) => (
                <li key={c.conversationId} className="flex items-center justify-between gap-2 text-xs rounded-lg px-2 py-1.5 hover:bg-white/[0.03] transition-colors">
                  <span className="truncate text-[#9B9BA4]">{c.title ?? c.conversationId.slice(0, 8)}</span>
                  <span className="shrink-0 text-[#C9A84C] font-medium">{fmtUsd(c.totalUsd)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Telegram daily chart */}
      {(data.telegramDailyLast30?.length ?? 0) > 0 && (
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-md p-4">
          <p className="text-xs font-semibold text-[#9B9BA4] mb-3">📱 Telegram — দৈনিক খরচ (৩০ দিন)</p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={data.telegramDailyLast30.map((d) => ({
              date: d.date.slice(5),
              total: d.totalUsd,
            }))}>
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#6B6B72' }} axisLine={{ stroke: '#1E1E24' }} tickLine={false} />
              <YAxis tick={{ fontSize: 9, fill: '#6B6B72' }} axisLine={{ stroke: '#1E1E24' }} tickLine={false} tickFormatter={(v) => `$${v}`} />
              <Tooltip
                formatter={(v: number) => fmtUsd(v)}
                contentStyle={{ backgroundColor: 'rgba(20,20,24,0.95)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', backdropFilter: 'blur(12px)' }}
                labelStyle={{ color: '#FAFAF8' }}
                itemStyle={{ color: '#9B9BA4' }}
              />
              <Bar dataKey="total" fill="#3B82F6" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Subscriptions */}
      <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-md p-4">
        <p className="text-xs font-semibold text-[#9B9BA4] mb-3">সাবস্ক্রিপশন</p>
        {data.subscriptions.length === 0 ? (
          <p className="text-[11px] text-[#6B6B72] py-4 text-center">
            কোনো সাবস্ক্রিপশন নেই — এজেন্টকে বলুন: &quot;ChatGPT subscription add koro…&quot;
          </p>
        ) : (
          <ul className="space-y-2">
            {data.subscriptions.map((s) => {
              const badge = renewalBadge(s.nextRenewalAt)
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm px-3 py-2.5 hover:bg-white/[0.04] transition-all">
                  <div>
                    <p className="text-xs font-medium text-[#FAFAF8]">{s.name}</p>
                    <p className="text-[10px] text-[#6B6B72]">
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
