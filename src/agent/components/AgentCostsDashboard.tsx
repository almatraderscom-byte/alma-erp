'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts'
import { cn } from '@/lib/utils'
import { AgentSubHeader } from '@/agent/components/AgentSubHeader'

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
    plan: string | null; paymentMethod: string | null; providerId: string | null
    sourceType: string; invoiceAmount: number | null; invoiceCurrency: string | null
    invoiceDueAt: string | null; invoiceStatus: string | null; sourceUrl: string | null
    lastSyncedAt: string | null; syncStatus: string
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
  balanceKind: 'wallet' | 'manual_estimate' | 'quota' | 'none'
  balanceAmount: number | null
  balanceCurrency: string | null
  balanceUnit: string | null
  quota?: {
    used: number
    limit: number
    remaining: number
    unit: string
    plan: string | null
    resetAt: string | null
    subscription: number | null
    onDemand: number | null
    overage: { amount: number; currency: string } | null
  } | null
  usage?: {
    amount: number
    unit: string
    period: 'month'
  } | null
  invoice?: {
    kind: 'open' | 'next' | 'preview'
    amount: number
    currency: string
    dueAt: string | null
    status: string
  } | null
  todayUsd: number | null
  monthUsd: number | null
  providerMonthUsd?: number | null
  localDeltaUsd?: number | null
  source: string
  sourceType: string
  costSourceType: string
  status: 'live' | 'partial' | 'manual' | 'unconfigured' | 'stale' | 'error' | 'free'
  statusMessage?: string | null
  balanceAuthoritative: boolean
  costAuthoritative: boolean
  planAuthoritative: boolean
  authoritative: boolean
  fetchedAt: string
  staleAfter: string | null
  dashboardUrl?: string | null
  plan?: string | null
  capabilities: string[]
  configuredCapabilities?: string[]
  free?: boolean
  syncedThrough?: string | null
}

type BalanceData = {
  checkedAt: string
  providers: BalanceProviderRow[]
  summaryLine: string
  dueSummary?: {
    dueNow: number
    dueWithin7Days: number
    dueWithin30Days: number
    amountsWithin30Days: Array<{ currency: string; amount: number }>
  }
}

type CostLogEvent = {
  id: string
  occurredAt: string
  provider: string
  model: string | null
  kind: string
  kindLabel: string
  costUsd: number
  inputTokens: number | null
  outputTokens: number | null
  conversationId: string | null
  conversationTitle: string | null
  source: string | null
  snippet: string | null
}

type ConversationCostMessage = {
  id: string
  role: string
  text: string
  model: string | null
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number
  createdAt: string
}

type ConversationCostDetail = {
  conversationId: string
  title: string | null
  source: string | null
  totalCostUsd: number
  totalTokensIn: number
  totalTokensOut: number
  messageCount: number
  messages: ConversationCostMessage[]
}

type ProviderLogMessage = {
  id: string
  occurredAt: string
  kind: string
  kindLabel: string
  model: string | null
  headline: string
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number
  conversationId: string | null
  source: string | null
}

type ProviderLogConversation = {
  conversationId: string
  title: string | null
  source: string | null
  totalCostUsd: number
  totalTokensIn: number
  totalTokensOut: number
  messageCount: number
  lastAt: string
}

type ProviderLogs = {
  provider: string
  from: string
  to: string
  totalCostUsd: number
  totalTokensIn: number
  totalTokensOut: number
  eventCount: number
  messages: ProviderLogMessage[]
  conversations: ProviderLogConversation[]
}

type LogRange = 'today' | '7d' | '30d' | 'custom'

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
  if (days < 0) return { label: 'মেয়াদোত্তীর্ণ', cls: 'tone-red border shadow-sm' }
  if (days <= 3) return { label: `${days} দিন`, cls: 'tone-amber border shadow-sm' }
  if (days <= 14) return { label: `${days} দিন`, cls: 'bg-[#E07A5F]/10 border border-[#E07A5F]/20 text-[#E07A5F]' }
  return { label: `${days} দিন`, cls: 'bg-transparent border border-border-subtle text-muted' }
}

function fmtBalanceCell(row: BalanceProviderRow) {
  if (row.free) return 'Free'
  if (row.balanceKind === 'wallet' && row.balanceAmount != null) {
    return row.balanceCurrency === 'USD'
      ? fmtUsd(row.balanceAmount)
      : `${row.balanceCurrency ?? ''} ${row.balanceAmount.toFixed(2)}`.trim()
  }
  if (row.balanceKind === 'quota' && row.quota) {
    return `${Math.round(row.quota.remaining).toLocaleString()} ${row.quota.unit === 'characters' ? 'chars' : row.quota.unit}`
  }
  if (row.balanceKind === 'manual_estimate' && row.balanceAmount != null) {
    const amount = row.balanceUnit === 'USD'
      ? fmtUsd(row.balanceAmount)
      : `${Math.round(row.balanceAmount).toLocaleString()} ${row.balanceUnit ?? ''}`.trim()
    return row.balanceAmount < 0 ? `${amount} · estimate শেষ` : `${amount} · estimate`
  }
  if (
    row.capabilities.includes('wallet')
    && !(row.configuredCapabilities ?? []).includes('wallet')
  ) {
    return 'Credential দরকার'
  }
  if (
    row.capabilities.includes('quota')
    && !(row.configuredCapabilities ?? []).includes('quota')
  ) {
    return 'Credential দরকার'
  }
  return 'Wallet API নেই'
}

function fmtSpendCell(n: number | null, providerId?: string) {
  if (n == null) return '—'
  if (providerId === 'oxylabs') return `${Math.round(n)} ক্রেডিট`
  return fmtUsd(n)
}

const STATUS_STYLE: Record<BalanceProviderRow['status'], { label: string; cls: string }> = {
  live: { label: 'Connected', cls: 'tone-green border' },
  partial: { label: 'Mixed (legacy)', cls: 'tone-blue border' },
  manual: { label: 'Local only', cls: 'tone-amber border' },
  unconfigured: { label: 'Connect', cls: 'border border-border-subtle text-muted' },
  stale: { label: 'Stale', cls: 'tone-amber border' },
  error: { label: 'Error', cls: 'tone-red border' },
  free: { label: 'Free', cls: 'tone-green border' },
}

type FieldTruth =
  | 'live'
  | 'delayed'
  | 'estimated'
  | 'not_exposed'
  | 'needs_credential'
  | 'sync_error'
  | 'no_current_value'

const FIELD_TRUTH: Record<FieldTruth, { label: string; cls: string }> = {
  live: { label: 'Live', cls: 'tone-green border' },
  delayed: { label: 'Provider delayed', cls: 'tone-blue border' },
  estimated: { label: 'Local estimate', cls: 'tone-amber border' },
  not_exposed: { label: 'Not exposed', cls: 'border border-border-subtle text-muted' },
  needs_credential: { label: 'Needs credential', cls: 'tone-amber border' },
  sync_error: { label: 'Sync error', cls: 'tone-red border' },
  no_current_value: { label: 'None reported', cls: 'border border-border-subtle text-muted' },
}

function providerFieldTruth(row: BalanceProviderRow) {
  const configured = new Set(row.configuredCapabilities ?? [])
  const hasCapability = (field: string) => row.capabilities.includes(field)
  const needsCredential = (field: string) => hasCapability(field) && !configured.has(field)
  const syncFailed = (field: string) => hasCapability(field) && configured.has(field) && row.status === 'error'
  return {
    balance: row.balanceAuthoritative
      ? 'live'
      : row.balanceKind === 'manual_estimate'
        ? 'estimated'
        : needsCredential('wallet') || needsCredential('quota')
          ? 'needs_credential'
          : syncFailed('wallet') || syncFailed('quota')
            ? 'sync_error'
          : 'not_exposed',
    cost: row.costAuthoritative
      ? (row.costSourceType === 'provider_export' || Boolean(row.syncedThrough) ? 'delayed' : 'live')
      : needsCredential('cost')
          ? 'needs_credential'
          : syncFailed('cost')
            ? 'sync_error'
            : row.monthUsd != null
              ? 'estimated'
              : hasCapability('cost') && configured.has('cost')
                ? 'no_current_value'
                : 'not_exposed',
    plan: row.planAuthoritative
      ? 'live'
      : needsCredential('plan')
        ? 'needs_credential'
        : syncFailed('plan')
          ? 'sync_error'
          : hasCapability('plan') && configured.has('plan')
            ? 'no_current_value'
            : 'not_exposed',
    invoice: row.invoice
      ? 'live'
      : needsCredential('invoice')
        ? 'needs_credential'
        : syncFailed('invoice')
          ? 'sync_error'
          : hasCapability('invoice') && configured.has('invoice')
            ? 'no_current_value'
        : 'not_exposed',
    usage: row.usage || row.quota
      ? 'live'
      : row.costAuthoritative && row.costSourceType === 'provider_export'
        ? 'delayed'
        : needsCredential('usage')
          ? 'needs_credential'
          : syncFailed('usage')
            ? 'sync_error'
            : row.monthUsd != null
              ? 'estimated'
              : hasCapability('usage') && configured.has('usage')
                ? 'no_current_value'
                : 'not_exposed',
  } satisfies Record<string, FieldTruth>
}

const SOURCE_LABEL: Record<string, string> = {
  provider_api: 'Provider API',
  provider_export: 'Billing export',
  local_measured: 'Local measured',
  manual: 'Manual',
  free: 'Free',
}

// "2026-06-21" → "২১ জুন" (Bangla short date) for the sync note.
function fmtSyncDate(ymd: string): string {
  try {
    return new Date(`${ymd}T00:00:00Z`).toLocaleDateString('bn-BD', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
    })
  } catch {
    return ymd
  }
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

function fmtShortTime(iso: string) {
  try {
    return new Date(iso).toLocaleString('bn-BD', {
      timeZone: 'Asia/Dhaka',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  } catch {
    return iso
  }
}

function fmtTokens(inTok: number | null, outTok: number | null) {
  if (inTok == null && outTok == null) return '—'
  return `${(inTok ?? 0).toLocaleString()}→${(outTok ?? 0).toLocaleString()}`
}

function balanceColor(row: BalanceProviderRow): string {
  if (row.free) return 'txt-pos'
  if (row.balanceKind === 'manual_estimate') return row.balanceAmount != null && row.balanceAmount < 0 ? 'txt-neg' : 'text-amber-400'
  if (row.balanceAmount == null) return 'text-muted'
  if (row.balanceAmount < 1) return 'txt-neg'
  if (row.balanceAmount < 5 && row.balanceKind === 'wallet') return 'text-amber-400'
  return 'txt-pos'
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
  const [logs, setLogs] = useState<CostLogEvent[] | null>(null)
  const [logsLoading, setLogsLoading] = useState(false)
  const [convDetail, setConvDetail] = useState<ConversationCostDetail | null>(null)
  const [convLoading, setConvLoading] = useState(false)
  // Per-provider Logs drilldown (opened from the balance table).
  const [logProvider, setLogProvider] = useState<{ id: string; label: string } | null>(null)
  const [logRange, setLogRange] = useState<LogRange>('today')
  const [logFrom, setLogFrom] = useState('')
  const [logTo, setLogTo] = useState('')
  const [providerLogs, setProviderLogs] = useState<ProviderLogs | null>(null)
  const [providerLogsLoading, setProviderLogsLoading] = useState(false)

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

  const loadLogs = useCallback(async () => {
    setLogsLoading(true)
    try {
      const res = await fetch('/api/assistant/costs/logs?limit=100')
      if (!res.ok) throw new Error('লগ লোড ব্যর্থ')
      const json = await res.json() as { events: CostLogEvent[] }
      setLogs(json.events ?? [])
    } catch {
      setLogs([])
    } finally {
      setLogsLoading(false)
    }
  }, [])

  async function openConversation(conversationId: string) {
    setConvLoading(true)
    setConvDetail({ conversationId, title: null, source: null, totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0, messageCount: 0, messages: [] })
    try {
      const res = await fetch(`/api/assistant/costs/logs?conversationId=${encodeURIComponent(conversationId)}`)
      if (!res.ok) throw new Error('চ্যাট লোড ব্যর্থ')
      setConvDetail(await res.json() as ConversationCostDetail)
    } catch {
      setConvDetail(null)
    } finally {
      setConvLoading(false)
    }
  }

  const fetchProviderLogs = useCallback(async (
    providerId: string,
    range: LogRange,
    from: string,
    to: string,
  ) => {
    setProviderLogsLoading(true)
    try {
      const qs = new URLSearchParams({ provider: providerId })
      if (range === 'custom' && from && to) {
        qs.set('from', from)
        qs.set('to', to)
      } else {
        qs.set('range', range)
      }
      const res = await fetch(`/api/assistant/costs/logs?${qs.toString()}`)
      if (!res.ok) throw new Error('লগ লোড ব্যর্থ')
      setProviderLogs(await res.json() as ProviderLogs)
    } catch {
      setProviderLogs(null)
    } finally {
      setProviderLogsLoading(false)
    }
  }, [])

  function openProviderLogs(providerId: string, label: string) {
    setLogProvider({ id: providerId, label })
    setLogRange('today')
    setProviderLogs(null)
    void fetchProviderLogs(providerId, 'today', '', '')
  }

  function selectRange(range: LogRange) {
    setLogRange(range)
    if (range !== 'custom' && logProvider) {
      void fetchProviderLogs(logProvider.id, range, '', '')
    }
  }

  function applyCustomRange() {
    if (logProvider && logFrom && logTo) {
      void fetchProviderLogs(logProvider.id, 'custom', logFrom, logTo)
    }
  }

  useEffect(() => { void load(); void loadLogs() }, [load, loadLogs])

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
  const walletTotal = (balances?.providers ?? [])
    .filter((row) => row.balanceKind === 'wallet' && row.balanceCurrency === 'USD')
    .reduce((sum, row) => sum + (row.balanceAmount ?? 0), 0)
  const confirmedMonth = (balances?.providers ?? [])
    .filter((row) => row.costAuthoritative && row.providerMonthUsd != null)
    .reduce((sum, row) => sum + (row.providerMonthUsd ?? 0), 0)
  const providerAttention = (balances?.providers ?? [])
    .filter((row) => row.status === 'error' || row.status === 'stale').length
  const missingConnections = (balances?.providers ?? [])
    .filter((row) => row.status === 'unconfigured').length

  if (loading) {
    return (
      <>
        <AgentSubHeader title="AI খরচ" accent="ড্যাশবোর্ড" subtitle="API + সাবস্ক্রিপশন — এক জায়গায়" />
        <div className="safe-x mx-auto max-w-5xl space-y-4 p-4 pb-[max(16px,env(safe-area-inset-bottom))] md:p-6 bg-transparent">
          <div className="skeleton h-8 w-48 rounded-lg" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-24 rounded-2xl" />
            ))}
          </div>
          <div className="skeleton h-56 rounded-2xl" />
        </div>
      </>
    )
  }

  if (error || !data) {
    return (
      <>
        <AgentSubHeader title="AI খরচ" accent="ড্যাশবোর্ড" />
        <div className="flex min-h-[50dvh] flex-col items-center justify-center gap-3 p-6 text-center bg-transparent">
          <p className="text-sm text-red-500">⚠️ {error ?? 'ডেটা পাওয়া যায়নি'}</p>
          <button onClick={() => void load()} className="rounded-xl border border-border-subtle bg-card/80 px-4 py-2 text-xs text-muted hover:text-cream hover:border-[#E07A5F]/30 shadow-sm transition-all">
            আবার চেষ্টা
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <AgentSubHeader
        title="AI খরচ"
        accent="ড্যাশবোর্ড"
        subtitle="API + সাবস্ক্রিপশন — এক জায়গায়"
        actions={
          <a
            href="/api/assistant/costs/export"
            className="rounded-xl bg-[#E07A5F]/10 border border-[#E07A5F]/20 px-3 py-2 text-xs font-semibold text-[#E07A5F] hover:bg-[#E07A5F]/15 hover:shadow-[0_2px_12px_rgba(224,122,95,0.12)] transition-all"
          >
            CSV
          </a>
        }
      />
    <div className="safe-x mx-auto max-w-5xl space-y-6 p-4 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:p-6 md:pb-6 bg-transparent">
      {/* Truthful provider billing hub */}
      <section className="space-y-3">
        <div className="rounded-[18px] border border-border-subtle bg-card/80 p-4 shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-[#E07A5F]">💳 Provider billing hub</p>
              <p className="mt-1 max-w-2xl text-[10px] leading-relaxed text-muted">
                Cash wallet, quota, provider cost ও manual estimate আলাদা। “Live” শুধু official provider value-এর জন্য।
              </p>
            </div>
            <div className="flex items-center gap-2">
              {balances?.checkedAt && (
                <p className="text-[10px] text-muted">শেষ full sync: {fmtCheckedAt(balances.checkedAt)}</p>
              )}
              <button
                onClick={() => void refreshBalances()}
                disabled={refreshingBalances}
                className="rounded-lg border border-border-subtle bg-transparent px-2.5 py-1 text-[10px] text-muted hover:border-[#E07A5F]/30 hover:text-cream disabled:opacity-50 transition-all"
              >
                {refreshingBalances ? 'সব provider sync হচ্ছে…' : '🔄 সব refresh'}
              </button>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
            {[
              {
                label: 'Prepaid cash',
                value: fmtUsd(walletTotal),
                note: 'শুধু verified USD wallets',
              },
              {
                label: 'Provider-confirmed MTD',
                value: fmtUsd(confirmedMonth),
                note: 'শুধু API/export প্রকাশিত অংশ',
              },
              {
                label: 'আগামী ৭ দিনে due',
                value: `${balances?.dueSummary?.dueWithin7Days ?? 0}টি`,
                note: balances?.dueSummary?.amountsWithin30Days?.length
                  ? balances.dueSummary.amountsWithin30Days.map((item) => `${item.currency} ${item.amount}`).join(' · ')
                  : 'কোনো tracked amount নেই',
              },
              {
                label: 'Sync health',
                value: providerAttention ? `${providerAttention} attention` : 'Healthy',
                note: `${missingConnections}টি optional connection বাকি`,
              },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border border-border-subtle bg-black/[0.02] p-3">
                <p className="text-[9px] uppercase tracking-wider text-muted">{item.label}</p>
                <p className="mt-1 text-lg font-bold text-cream">{item.value}</p>
                <p className="mt-1 text-[9px] text-muted">{item.note}</p>
              </div>
            ))}
          </div>
        </div>

        {!balances?.providers?.length ? (
          <div className="rounded-[18px] border border-border-subtle bg-card/80 py-8 text-center text-[11px] text-muted shadow-card">
            Provider data লোড হচ্ছে…
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {balances.providers.map((row) => {
              const state = STATUS_STYLE[row.status]
              const fieldTruth = providerFieldTruth(row)
              const quotaPct = row.quota?.limit
                ? Math.min(100, Math.max(0, (row.quota.used / row.quota.limit) * 100))
                : 0
              return (
                <article key={row.id} className="rounded-[18px] border border-border-subtle bg-card/80 p-4 shadow-card">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-cream">{row.label}</p>
                      <p className="mt-0.5 text-[9px] text-muted">
                        {row.plan ? `${row.plan} · ` : ''}{row.capabilities.join(' · ')}
                      </p>
                    </div>
                    <span className={cn('rounded-full px-2 py-0.5 text-[9px] font-semibold', state.cls)}>
                      {state.label}
                    </span>
                  </div>

                  <div className="mt-3">
                    <p className="text-[9px] uppercase tracking-wider text-muted">
                      {row.balanceKind === 'wallet'
                        ? 'Cash wallet'
                        : row.balanceKind === 'quota'
                          ? 'Available quota'
                          : row.balanceKind === 'manual_estimate'
                            ? 'Manual estimate'
                            : 'Wallet'}
                    </p>
                    <p className={cn('mt-1 text-xl font-bold tabular-nums', balanceColor(row))}>
                      {fmtBalanceCell(row)}
                    </p>
                    <p className="mt-1 text-[9px] text-muted">
                      {row.balanceKind === 'none'
                        ? 'No wallet endpoint'
                        : (SOURCE_LABEL[row.sourceType] ?? row.sourceType)}
                      {' · '}{row.balanceAuthoritative ? 'provider verified' : 'not provider verified'}
                    </p>
                    {row.quota && row.quota.limit > 0 && (
                      <div className="mt-2">
                        <div className="h-1.5 overflow-hidden rounded-full bg-black/10">
                          <div
                            className="h-full rounded-full bg-[#E07A5F]"
                            style={{ width: `${quotaPct}%` }}
                          />
                        </div>
                        <p className="mt-1 text-[9px] text-muted">
                          Used {Math.round(row.quota.used).toLocaleString()} / {Math.round(row.quota.limit).toLocaleString()}
                          {row.quota.subscription != null ? ` · plan ${row.quota.subscription}` : ''}
                          {row.quota.onDemand != null ? ` · on-demand ${row.quota.onDemand}` : ''}
                          {row.quota.overage ? ` · overage ${row.quota.overage.currency} ${row.quota.overage.amount.toFixed(2)}` : ''}
                        </p>
                      </div>
                    )}
                    {row.usage && (
                      <p className="mt-2 text-[9px] font-semibold text-cream">
                        This month {Math.round(row.usage.amount).toLocaleString()} {row.usage.unit}
                      </p>
                    )}
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border-subtle pt-3">
                    <div>
                      <p className="text-[9px] text-muted">আজ</p>
                      <p className="mt-0.5 text-xs font-semibold text-cream">{fmtSpendCell(row.todayUsd, row.id)}</p>
                    </div>
                    <div>
                      <p className="text-[9px] text-muted">এই মাস</p>
                      <p className="mt-0.5 text-xs font-semibold text-cream">{fmtSpendCell(row.monthUsd, row.id)}</p>
                    </div>
                    <div>
                      <p className="text-[9px] text-muted">Cost source</p>
                      <p className="mt-0.5 text-[10px] font-semibold text-cream">
                        {SOURCE_LABEL[row.costSourceType] ?? row.costSourceType}
                      </p>
                      <p className="mt-0.5 text-[8px] text-muted">
                        {row.costAuthoritative ? 'provider base' : 'estimate'}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {(Object.entries(fieldTruth) as Array<[keyof typeof fieldTruth, FieldTruth]>).map(([field, truth]) => (
                      <span
                        key={field}
                        className={cn('rounded-full px-2 py-0.5 text-[8px] font-semibold', FIELD_TRUTH[truth].cls)}
                      >
                        {field} · {FIELD_TRUTH[truth].label}
                      </span>
                    ))}
                  </div>

                  {row.invoice && (
                    <div className="mt-3 rounded-xl border border-[#D4A84B]/25 bg-[#D4A84B]/[0.06] px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[9px] font-semibold uppercase tracking-wider text-[#D4A84B]">
                          {row.invoice.kind === 'open'
                            ? 'Open invoice'
                            : row.invoice.kind === 'preview'
                              ? 'Current invoice preview'
                              : 'Next invoice'}
                        </p>
                        <p className="text-xs font-bold tabular-nums text-cream">
                          {row.invoice.currency} {row.invoice.amount.toFixed(2)}
                        </p>
                      </div>
                      <p className="mt-1 text-[9px] text-muted">
                        Status {row.invoice.status}
                        {row.invoice.dueAt ? ` · Due ${fmtCheckedAt(row.invoice.dueAt)}` : ' · due date not published'}
                      </p>
                    </div>
                  )}

                  <div className="mt-3 space-y-1 text-[9px] leading-relaxed text-muted">
                    <p>{row.statusMessage ?? row.source}</p>
                    <p>
                      Fetched {fmtCheckedAt(row.fetchedAt)}
                      {row.syncedThrough ? ` · provider data ${fmtSyncDate(row.syncedThrough)} পর্যন্ত` : ''}
                      {row.localDeltaUsd != null && row.localDeltaUsd > 0
                        ? ` · এরপর local ${fmtUsd(row.localDeltaUsd)}`
                        : ''}
                    </p>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {row.dashboardUrl && (
                      <a
                        href={row.dashboardUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-lg border border-border-subtle px-2.5 py-1 text-[10px] font-semibold text-muted hover:border-[#E07A5F]/30 hover:text-[#E07A5F]"
                      >
                        Provider খুলুন ↗
                      </a>
                    )}
                    {!row.free && (
                      <button
                        onClick={() => openProviderLogs(row.id, row.label)}
                        className="rounded-lg border border-[#E07A5F]/25 bg-[#E07A5F]/[0.06] px-2.5 py-1 text-[10px] font-semibold text-[#E07A5F]"
                      >
                        📊 Local logs
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

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
          <div className="overflow-x-auto min-w-0 max-w-full table-scroll">
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

      {/* API খরচের লগ — every spend event across all APIs, newest first. Chat rows
          are clickable → full per-message cost breakdown of that conversation. */}
      <div className="rounded-[18px] border border-border-subtle bg-card/80 p-4 shadow-card">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold text-[#E07A5F]">📋 API খরচের লগ (সব API)</p>
          <button
            onClick={() => void loadLogs()}
            disabled={logsLoading}
            className="rounded-lg border border-border-subtle bg-transparent px-2.5 py-1 text-[10px] text-muted hover:text-cream hover:border-[#E07A5F]/30 disabled:opacity-50 transition-all"
          >
            {logsLoading ? 'লোড…' : '🔄 Refresh'}
          </button>
        </div>
        <p className="text-[10px] text-muted mb-3">প্রতিটি API কল — সময়, মডেল, কত টোকেন, কত খরচ। চ্যাট লাইনে ক্লিক করলে পুরো কথোপকথনের message-ভিত্তিক হিসাব দেখাবে।</p>
        {!logs || logs.length === 0 ? (
          <p className="py-6 text-center text-[11px] text-muted">{logsLoading ? 'লোড হচ্ছে…' : 'এখনো কোনো খরচ লগ নেই'}</p>
        ) : (
          <div className="max-h-[28rem] overflow-y-auto overflow-x-auto min-w-0 max-w-full table-scroll">
            <table className="w-full min-w-[640px] text-left text-[11px]">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border-subtle">
                  <th className="py-2 pr-3 font-medium text-[#E07A5F]">সময়</th>
                  <th className="py-2 pr-3 font-medium text-[#E07A5F]">Provider</th>
                  <th className="py-2 pr-3 font-medium text-[#E07A5F]">মডেল / ধরন</th>
                  <th className="py-2 pr-3 font-medium text-[#E07A5F]">কী হয়েছে</th>
                  <th className="py-2 pr-3 font-medium text-[#E07A5F] text-right">টোকেন</th>
                  <th className="py-2 font-medium text-[#E07A5F] text-right">খরচ</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((ev) => {
                  const clickable = Boolean(ev.conversationId)
                  return (
                    <tr
                      key={ev.id}
                      onClick={() => ev.conversationId && void openConversation(ev.conversationId)}
                      className={cn(
                        'border-b border-border-subtle last:border-0 transition-colors',
                        clickable ? 'cursor-pointer hover:bg-white/[0.05]' : 'hover:bg-white/[0.02]',
                      )}
                    >
                      <td className="py-2 pr-3 text-muted whitespace-nowrap">{fmtCheckedAt(ev.occurredAt)}</td>
                      <td className="py-2 pr-3">
                        <span className="inline-flex items-center gap-1.5 text-cream">
                          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PROVIDER_COLORS[ev.provider] ?? '#94a3b8' }} />
                          {PROVIDER_LABELS[ev.provider] ?? ev.provider}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-muted">
                        {ev.model ?? ev.kindLabel}
                        {ev.source === 'telegram' && <span className="ml-1.5 text-[9px]">📱</span>}
                        {ev.source === 'web' && <span className="ml-1.5 text-[9px]">🌐</span>}
                      </td>
                      <td className="py-2 pr-3 text-muted max-w-[220px] truncate">
                        {ev.snippet ?? <span className="opacity-60">{ev.kindLabel}</span>}
                      </td>
                      <td className="py-2 pr-3 text-right text-muted tabular-nums whitespace-nowrap">
                        {ev.inputTokens != null || ev.outputTokens != null
                          ? `${(ev.inputTokens ?? 0).toLocaleString()}→${(ev.outputTokens ?? 0).toLocaleString()}`
                          : '—'}
                      </td>
                      <td className="py-2 text-right font-medium text-[#E07A5F] tabular-nums whitespace-nowrap">{fmtUsd(ev.costUsd)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Subscriptions */}
      <div className="rounded-[18px] border border-border-subtle bg-card/80 p-4 shadow-card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-semibold text-muted">Subscriptions & invoices</p>
            <p className="mt-1 text-[9px] text-muted">
              Due এখন {balances?.dueSummary?.dueNow ?? 0} · ৭ দিনে {balances?.dueSummary?.dueWithin7Days ?? 0} · ৩০ দিনে {balances?.dueSummary?.dueWithin30Days ?? 0}
            </p>
          </div>
          <span className="rounded-full border border-border-subtle px-2 py-0.5 text-[9px] text-muted">
            {data.subscriptions.length} tracked
          </span>
        </div>
        {data.subscriptions.length === 0 ? (
          <p className="text-[11px] text-muted py-4 text-center">
            Provider usage উপরে live আছে, কিন্তু renewal/invoice track করার subscription এখনো যোগ করা হয়নি।
          </p>
        ) : (
          <ul className="space-y-2">
            {data.subscriptions.map((s) => {
              const dueDate = s.invoiceDueAt ?? s.nextRenewalAt
              const badge = renewalBadge(dueDate)
              const chargeAmount = s.invoiceAmount ?? s.amount
              const chargeCurrency = s.invoiceCurrency ?? s.currency
              return (
                <li key={s.id} className="rounded-xl border border-border-subtle bg-transparent px-3 py-3 hover:bg-card/80 hover:shadow-sm transition-all">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-medium text-cream">{s.name}</p>
                      <p className="text-[10px] text-muted">
                        {s.plan ?? s.providerId ?? s.category ?? 'Manual subscription'}
                        {' · '}{chargeCurrency} {chargeAmount}/{s.billingCycle === 'yearly' ? 'বছর' : 'মাস'}
                      </p>
                    </div>
                    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', badge.cls)}>
                      {badge.label}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] text-muted">
                    <span>Due {dueDate}</span>
                    <span>Source: {SOURCE_LABEL[s.sourceType] ?? s.sourceType}</span>
                    <span>Sync: {s.syncStatus}</span>
                    {s.invoiceStatus && <span>Invoice: {s.invoiceStatus}</span>}
                    {s.lastSyncedAt && <span>Updated {fmtShortTime(s.lastSyncedAt)}</span>}
                    {s.sourceUrl && (
                      <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-[#E07A5F] hover:underline">
                        Source ↗
                      </a>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Per-provider Logs drilldown — date window + side-by-side messages / conversations. */}
      {logProvider && (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
          onClick={() => setLogProvider(null)}
        >
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[92dvh] w-full max-w-5xl flex-col overflow-hidden rounded-t-2xl border border-border-subtle bg-card shadow-xl sm:rounded-2xl"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-3 border-b border-border-subtle p-4">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-semibold text-cream">
                  <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: PROVIDER_COLORS[logProvider.id] ?? '#94a3b8' }} />
                  {logProvider.label} — খরচের লগ
                </p>
                {providerLogs && (
                  <p className="mt-0.5 text-[11px] text-muted">
                    {providerLogs.from === providerLogs.to ? providerLogs.from : `${providerLogs.from} → ${providerLogs.to}`}
                    {' · '}{providerLogs.eventCount} ইভেন্ট · মোট টোকেন{' '}
                    <span className="font-semibold text-cream tabular-nums">
                      {(providerLogs.totalTokensIn + providerLogs.totalTokensOut).toLocaleString()}
                    </span>
                    {' · মোট খরচ '}
                    <span className="font-semibold text-[#E07A5F]">{fmtUsd(providerLogs.totalCostUsd)}</span>
                  </p>
                )}
              </div>
              <button
                onClick={() => setLogProvider(null)}
                className="shrink-0 rounded-lg border border-border-subtle bg-transparent px-2.5 py-1 text-xs text-muted hover:text-cream transition-all"
              >
                ✕
              </button>
            </div>

            {/* Date range selector */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-3">
              {([['today', 'আজ'], ['7d', 'গত ৭ দিন'], ['30d', 'গত ৩০ দিন'], ['custom', 'কাস্টম']] as Array<[LogRange, string]>).map(([key, lbl]) => (
                <button
                  key={key}
                  onClick={() => selectRange(key)}
                  className={cn(
                    'rounded-lg border px-3 py-1.5 text-[11px] font-medium transition-all',
                    logRange === key
                      ? 'border-[#E07A5F]/40 bg-[#E07A5F]/12 text-[#E07A5F] shadow-[0_2px_8px_rgba(224,122,95,0.12)]'
                      : 'border-border-subtle bg-transparent text-muted hover:text-cream hover:border-[#E07A5F]/25',
                  )}
                >
                  {lbl}
                </button>
              ))}
              {logRange === 'custom' && (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="date"
                    value={logFrom}
                    onChange={(e) => setLogFrom(e.target.value)}
                    className="rounded-lg border border-border bg-transparent px-2 py-1 text-[11px] text-cream focus:outline-none focus:border-[#E07A5F]/40"
                  />
                  <span className="text-[11px] text-muted">→</span>
                  <input
                    type="date"
                    value={logTo}
                    onChange={(e) => setLogTo(e.target.value)}
                    className="rounded-lg border border-border bg-transparent px-2 py-1 text-[11px] text-cream focus:outline-none focus:border-[#E07A5F]/40"
                  />
                  <button
                    onClick={() => applyCustomRange()}
                    disabled={!logFrom || !logTo}
                    className="rounded-lg bg-[#E07A5F]/10 border border-[#E07A5F]/20 px-3 py-1.5 text-[11px] font-semibold text-[#E07A5F] disabled:opacity-40 hover:bg-[#E07A5F]/15 transition-all"
                  >
                    দেখাও
                  </button>
                </div>
              )}
            </div>

            {/* Two panes */}
            {providerLogsLoading ? (
              <p className="py-16 text-center text-[11px] text-muted">লোড হচ্ছে…</p>
            ) : !providerLogs || providerLogs.eventCount === 0 ? (
              <p className="py-16 text-center text-[11px] text-muted">এই সময়ে {logProvider.label}-এ কোনো খরচ নেই</p>
            ) : (
              <div className="grid flex-1 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-2">
                {/* Left: messages */}
                <div className="flex min-h-0 flex-col overflow-hidden border-b border-border-subtle lg:border-b-0 lg:border-r">
                  <p className="shrink-0 border-b border-border-subtle px-4 py-2 text-[11px] font-semibold text-muted">
                    💬 মেসেজ অনুযায়ী ({providerLogs.messages.length})
                  </p>
                  <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
                    {providerLogs.messages.map((m) => (
                      <div
                        key={m.id}
                        onClick={() => m.conversationId && void openConversation(m.conversationId)}
                        className={cn(
                          'rounded-xl border border-border-subtle bg-transparent px-3 py-2 transition-colors',
                          m.conversationId ? 'cursor-pointer hover:bg-white/[0.05]' : '',
                        )}
                      >
                        <div className="mb-0.5 flex items-center justify-between gap-2">
                          <span className="truncate text-[10px] text-muted">
                            {m.model ?? m.kindLabel}
                            {m.source === 'telegram' && ' 📱'}
                            {m.source === 'web' && ' 🌐'}
                          </span>
                          <span className="shrink-0 text-[10px] text-muted">{fmtShortTime(m.occurredAt)}</span>
                        </div>
                        <p className="mb-1 line-clamp-2 break-words text-[11px] text-cream/90">{m.headline}</p>
                        <div className="flex items-center justify-between gap-2 text-[10px] tabular-nums">
                          <span className="text-muted">{fmtTokens(m.inputTokens, m.outputTokens)} tok</span>
                          <span className="font-semibold text-[#E07A5F]">{fmtUsd(m.costUsd)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Right: conversations */}
                <div className="flex min-h-0 flex-col overflow-hidden">
                  <p className="shrink-0 border-b border-border-subtle px-4 py-2 text-[11px] font-semibold text-muted">
                    🗂️ কথোপকথন অনুযায়ী ({providerLogs.conversations.length})
                  </p>
                  <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
                    {providerLogs.conversations.length === 0 ? (
                      <p className="py-8 text-center text-[11px] text-muted">এই সময়ে কোনো পূর্ণ কথোপকথন নেই</p>
                    ) : (
                      providerLogs.conversations.map((c) => (
                        <div
                          key={c.conversationId}
                          onClick={() => void openConversation(c.conversationId)}
                          className="cursor-pointer rounded-xl border border-border-subtle bg-transparent px-3 py-2.5 transition-colors hover:bg-white/[0.05]"
                        >
                          <div className="mb-1 flex items-start justify-between gap-2">
                            <span className="truncate text-[11px] font-medium text-cream">
                              {c.source === 'telegram' ? '📱 ' : '🌐 '}
                              {c.title ?? c.conversationId.slice(0, 8)}
                            </span>
                            <span className="shrink-0 text-[11px] font-semibold text-[#E07A5F] tabular-nums">{fmtUsd(c.totalCostUsd)}</span>
                          </div>
                          <div className="flex items-center justify-between gap-2 text-[10px] text-muted tabular-nums">
                            <span>{c.messageCount} মেসেজ · {(c.totalTokensIn + c.totalTokensOut).toLocaleString()} tok</span>
                            <span>{fmtShortTime(c.lastAt)}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        </div>
      )}

      {/* Conversation cost detail — full chat with per-message cost. */}
      {convDetail && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
          onClick={() => setConvDetail(null)}
        >
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[85dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-border-subtle bg-card shadow-xl sm:rounded-2xl"
          >
            <div className="flex items-start justify-between gap-3 border-b border-border-subtle p-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-cream">
                  {convDetail.source === 'telegram' ? '📱 ' : '🌐 '}
                  {convDetail.title ?? 'কথোপকথন'}
                </p>
                <p className="mt-0.5 text-[11px] text-muted">
                  {convDetail.messageCount} message · মোট টোকেন{' '}
                  <span className="font-semibold text-cream tabular-nums">
                    {(convDetail.totalTokensIn + convDetail.totalTokensOut).toLocaleString()}
                  </span>{' '}
                  ({convDetail.totalTokensIn.toLocaleString()} in → {convDetail.totalTokensOut.toLocaleString()} out) · মোট খরচ{' '}
                  <span className="font-semibold text-[#E07A5F]">{fmtUsd(convDetail.totalCostUsd)}</span>
                </p>
              </div>
              <button
                onClick={() => setConvDetail(null)}
                className="shrink-0 rounded-lg border border-border-subtle bg-transparent px-2.5 py-1 text-xs text-muted hover:text-cream transition-all"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-4">
              {convLoading ? (
                <p className="py-8 text-center text-[11px] text-muted">লোড হচ্ছে…</p>
              ) : convDetail.messages.length === 0 ? (
                <p className="py-8 text-center text-[11px] text-muted">কোনো message নেই</p>
              ) : (
                convDetail.messages.map((m) => {
                  const isUser = m.role === 'user'
                  return (
                    <div
                      key={m.id}
                      className={cn(
                        'rounded-xl border px-3 py-2.5',
                        isUser
                          ? 'border-border-subtle bg-transparent'
                          : 'border-[#E07A5F]/20 bg-[#E07A5F]/[0.04]',
                      )}
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
                          {isUser ? '👤 Owner' : `🤖 ${m.model ?? 'Assistant'}`}
                        </span>
                        <span className="flex shrink-0 items-center gap-2 text-[10px] text-muted tabular-nums">
                          {(m.tokensIn != null || m.tokensOut != null) && (
                            <span>{(m.tokensIn ?? 0).toLocaleString()}→{(m.tokensOut ?? 0).toLocaleString()} tok</span>
                          )}
                          {m.costUsd > 0 && <span className="font-medium text-[#E07A5F]">{fmtUsd(m.costUsd)}</span>}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap break-words text-xs text-cream/90">
                        {m.text || <span className="opacity-50">—</span>}
                      </p>
                    </div>
                  )
                })
              )}
            </div>
          </motion.div>
        </div>
      )}
    </div>
    </>
  )
}
