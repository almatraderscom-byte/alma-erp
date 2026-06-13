'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts'
import { cn } from '@/lib/utils'

type DashboardData = {
  todayUsd: number
  monthUsd: number
  forecastUsd: number
  subscriptionAmortMonthUsd: number
  dailyLast30: Array<Record<string, number | string>>
  byProvider: Array<{ provider: string; totalUsd: number }>
  topConversations: Array<{ conversationId: string; title: string | null; totalUsd: number }>
  telegramTodayUsd: number
  telegramMonthUsd: number
  telegramDailyLast30: Array<{ date: string; totalUsd: number }>
  topTelegramDays: Array<{ date: string; totalUsd: number; conversations: number }>
  subscriptions: Array<{
    id: string; name: string; amount: number; currency: string
    billingCycle: string; nextRenewalAt: string; category: string | null
    dailyUsd: number
  }>
  budgets: { dailyUsd: number | null; monthlyUsd: number | null }
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
  if (days < 0) return { label: 'মেয়াদোত্তীর্ণ', cls: 'bg-red-500/20 text-red-300' }
  if (days <= 3) return { label: `${days} দিন`, cls: 'bg-amber-500/20 text-amber-200' }
  if (days <= 14) return { label: `${days} দিন`, cls: 'bg-gold/10 text-gold-lt' }
  return { label: `${days} দিন`, cls: 'bg-white/5 text-muted' }
}

function fmtBalanceCell(row: BalanceProviderRow) {
  if (row.free) return 'Free'
  if (row.balanceUsd == null) return '—'
  return fmtUsd(row.balanceUsd)
}

function fmtSpendCell(n: number | null) {
  if (n == null) return '—'
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
        <button onClick={() => void load()} className="rounded-xl border border-border px-4 py-2 text-xs text-muted-hi hover:text-cream">
          আবার চেষ্টা
        </button>
      </div>
    )
  }

  return (
    <div className="safe-top safe-x mx-auto max-w-5xl space-y-6 p-4 pb-[max(16px,env(safe-area-inset-bottom))] md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-gold-lt">AI খরচ ড্যাশবোর্ড</h1>
          <p className="text-[11px] text-muted">API + সাবস্ক্রিপশন — এক জায়গায়</p>
        </div>
        <div className="flex gap-2">
          <Link href="/agent" className="rounded-xl border border-border px-3 py-2 text-xs text-muted-hi hover:text-cream">
            ← চ্যাট
          </Link>
          <a
            href="/api/assistant/costs/export"
            className="rounded-xl bg-gold/10 border border-gold-dim/40 px-3 py-2 text-xs font-semibold text-gold-lt hover:bg-gold/20"
          >
            CSV ডাউনলোড
          </a>
        </div>
      </div>

      {/* API balances */}
      <div className="rounded-2xl border border-border bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold text-gold-lt">💳 API ব্যালেন্স</p>
          <div className="flex items-center gap-2">
            {balances?.checkedAt && (
              <p className="text-[10px] text-muted">
                শেষ চেক: {fmtCheckedAt(balances.checkedAt)}
              </p>
            )}
            <button
              onClick={() => void refreshBalances()}
              disabled={refreshingBalances}
              className="rounded-lg border border-border px-2.5 py-1 text-[10px] text-muted-hi hover:text-cream disabled:opacity-50"
            >
              {refreshingBalances ? 'রিফ্রেশ…' : '🔄 Refresh'}
            </button>
          </div>
        </div>
        {!balances?.providers?.length ? (
          <p className="py-4 text-center text-[11px] text-zinc-600">ব্যালেন্স লোড হচ্ছে…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-[11px]">
              <thead>
                <tr className="border-b border-border/60 text-muted">
                  <th className="py-2 pr-3 font-medium">Provider</th>
                  <th className="py-2 pr-3 font-medium">ব্যালেন্স</th>
                  <th className="py-2 pr-3 font-medium">আজ খরচ</th>
                  <th className="py-2 pr-3 font-medium">এই মাসে</th>
                  <th className="py-2 font-medium">সূত্র</th>
                </tr>
              </thead>
              <tbody>
                {balances.providers.map((row) => (
                  <tr key={row.id} className="border-b border-border/40 last:border-0">
                    <td className="py-2 pr-3 text-cream">{row.label}</td>
                    <td className="py-2 pr-3 font-medium text-gold-lt">{fmtBalanceCell(row)}</td>
                    <td className="py-2 pr-3 text-muted-hi">{fmtSpendCell(row.todayUsd)}</td>
                    <td className="py-2 pr-3 text-muted-hi">{fmtSpendCell(row.monthUsd)}</td>
                    <td className="py-2 text-muted">{row.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { label: 'আজ', value: fmtUsd(data.todayUsd) },
          { label: 'এই মাস', value: fmtUsd(data.monthUsd) },
          { label: 'পূর্বাভাস (মাস)', value: fmtUsd(data.forecastUsd) },
        ].map((c) => (
          <div key={c.label} className="rounded-2xl border border-border bg-surface p-4">
            <p className="text-[10px] uppercase tracking-wider text-muted">{c.label}</p>
            <p className="mt-1 text-2xl font-bold text-cream">{c.value}</p>
          </div>
        ))}
      </div>

      {/* Budget settings */}
      <div className="rounded-2xl border border-border bg-surface p-4">
        <p className="text-xs font-semibold text-gold-lt mb-3">বাজেট সতর্কতা (USD)</p>
        <div className="flex flex-wrap gap-3 items-end">
          <label className="text-[11px] text-muted">
            দৈনিক
            <input
              type="number"
              step="0.01"
              value={budgetDaily}
              onChange={(e) => setBudgetDaily(e.target.value)}
              className="mt-1 block w-28 rounded-lg bg-card border border-border px-2 py-1.5 text-xs text-cream"
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
              className="mt-1 block w-28 rounded-lg bg-card border border-border px-2 py-1.5 text-xs text-cream"
              placeholder="—"
            />
          </label>
          <button
            onClick={() => void saveBudget()}
            disabled={savingBudget}
            className="rounded-lg bg-gold/15 border border-gold-dim/40 px-3 py-1.5 text-xs text-gold-lt disabled:opacity-50"
          >
            {savingBudget ? 'সংরক্ষণ…' : 'সংরক্ষণ'}
          </button>
        </div>
        <p className="mt-2 text-[10px] text-zinc-600">৮০% → Tier 1 | ১০০% → Tier 2 critical</p>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-border bg-surface p-4">
          <p className="text-xs font-semibold text-muted-hi mb-3">দৈনিক খরচ (৩০ দিন)</p>
          {chartData.length === 0 ? (
            <p className="py-12 text-center text-[11px] text-zinc-600">এখনো কোনো ইভেন্ট নেই</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData}>
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#71717a' }} />
                <YAxis tick={{ fontSize: 9, fill: '#71717a' }} tickFormatter={(v) => `$${v}`} />
                <Tooltip formatter={(v: number) => fmtUsd(v)} />
                <Bar dataKey="anthropic" stackId="a" fill={PROVIDER_COLORS.anthropic} />
                <Bar dataKey="openai" stackId="a" fill={PROVIDER_COLORS.openai} />
                <Bar dataKey="gemini" stackId="a" fill={PROVIDER_COLORS.gemini} />
                <Bar dataKey="google_tts" stackId="a" fill={PROVIDER_COLORS.google_tts} />
                <Bar dataKey="twilio" stackId="a" fill={PROVIDER_COLORS.twilio} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="rounded-2xl border border-border bg-surface p-4">
          <p className="text-xs font-semibold text-muted-hi mb-3">প্রোভাইডার (এই মাস)</p>
          {pieData.length === 0 ? (
            <p className="py-12 text-center text-[11px] text-zinc-600">ডেটা নেই</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({ name }) => name}>
                  {pieData.map((e) => (
                    <Cell key={e.name} fill={PROVIDER_COLORS[e.name] ?? '#52525b'} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => fmtUsd(v)} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Top conversations */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-border bg-surface p-4">
          <p className="text-xs font-semibold text-muted-hi mb-3">🌐 Web — সবচেয়ে ব্যয়বহুল কথোপকথন</p>
          {data.topConversations.length === 0 ? (
            <p className="text-[11px] text-zinc-600 py-4 text-center">এখনো নেই</p>
          ) : (
            <ul className="space-y-2">
              {data.topConversations.map((c) => (
                <li key={c.conversationId} className="flex items-center justify-between gap-2 text-xs">
                  <Link href="/agent" className="truncate text-muted-hi hover:text-gold-lt">
                    {c.title ?? c.conversationId.slice(0, 8)}
                  </Link>
                  <span className="shrink-0 text-gold">{fmtUsd(c.totalUsd)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-border bg-surface p-4">
          <p className="text-xs font-semibold text-muted-hi mb-1">📱 Telegram — দৈনিক খরচ (শীর্ষ দিন)</p>
          <p className="text-[10px] text-muted mb-3">
            আজ {fmtUsd(data.telegramTodayUsd)} · এই মাসে {fmtUsd(data.telegramMonthUsd)}
          </p>
          {data.topTelegramDays.length === 0 ? (
            <p className="text-[11px] text-zinc-600 py-4 text-center">
              এখনো Telegram ট্যাগ করা কথোপকথন নেই — নতুন মেসেজ থেকে ট্র্যাক হবে
            </p>
          ) : (
            <ul className="space-y-2">
              {data.topTelegramDays.map((d) => (
                <li key={d.date} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-hi">{d.date}</span>
                  <span className="shrink-0 text-gold">{fmtUsd(d.totalUsd)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Telegram daily chart */}
      {(data.telegramDailyLast30?.length ?? 0) > 0 && (
        <div className="rounded-2xl border border-border bg-surface p-4">
          <p className="text-xs font-semibold text-muted-hi mb-3">📱 Telegram — দৈনিক খরচ (৩০ দিন)</p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={data.telegramDailyLast30.map((d) => ({
              date: d.date.slice(5),
              total: d.totalUsd,
            }))}>
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#71717a' }} />
              <YAxis tick={{ fontSize: 9, fill: '#71717a' }} tickFormatter={(v) => `$${v}`} />
              <Tooltip formatter={(v: number) => fmtUsd(v)} />
              <Bar dataKey="total" fill="#3B82F6" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Subscriptions — moved below telegram section */}
      <div className="rounded-2xl border border-border bg-surface p-4">
        <p className="text-xs font-semibold text-muted-hi mb-3">সাবস্ক্রিপশন</p>
        {data.subscriptions.length === 0 ? (
          <p className="text-[11px] text-zinc-600 py-4 text-center">
            কোনো সাবস্ক্রিপশন নেই — এজেন্টকে বলুন: &quot;ChatGPT subscription add koro…&quot;
          </p>
        ) : (
          <ul className="space-y-2">
            {data.subscriptions.map((s) => {
              const badge = renewalBadge(s.nextRenewalAt)
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 px-3 py-2.5">
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
