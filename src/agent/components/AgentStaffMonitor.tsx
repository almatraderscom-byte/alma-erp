'use client'

import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import type {
  StaffMonitorData,
  StaffMonitorRow,
} from '@/agent/lib/staff-monitor-types'
import { DUTY_TO_JOB, AGENT_CAPABILITIES } from '@/agent/lib/staff-monitor-types'
import {
  MonitorKPIStrip,
  MonitorStaffCards,
  MonitorDutyTimeline,
  MonitorAlertPanel,
  MonitorTrustEngine,
  MonitorBrainCard,
  MonitorQuickActions,
} from './monitor'
import { MonitorSalahTimeline } from './monitor/MonitorDutyTimeline'
import type { TrustRule } from './monitor/MonitorTrustEngine'
import type { BrainStats } from './monitor/MonitorBrainCard'

const AgentSalahTimesSettings = dynamic(
  () => import('@/agent/components/AgentSalahTimesSettings'),
  { ssr: false, loading: () => null },
)

/* ───────── Helpers ───────── */

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit' })
}

const TYPE_LABELS: Record<string, string> = {
  task_dispatch: 'টাস্ক', announcement: 'ঘোষণা', reminder: 'রিমাইন্ডার',
  presence: 'প্রেজেন্স', coaching: 'কোচিং', feedback_ack: 'ফিডব্যাক',
  task_redo: 'রিডু', proof_reminder: 'প্রমাণ',
}
function typeLabel(type: string) { return TYPE_LABELS[type] ?? type }

const ACK_TRACKED_TYPES = new Set(['task_dispatch', 'announcement', 'reminder', 'coaching', 'proof_reminder', 'task_redo', 'presence'])
function tracksAck(m: StaffMonitorRow): boolean {
  if (m.requiresAck) return true
  return ACK_TRACKED_TYPES.has(m.type) && (m.status === 'delivered' || m.status === 'sent' || !!m.acknowledgedAt)
}

/* ───────── Animations ───────── */

const fadeIn = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.3 } } }
const staggerContainer = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }

/* ───────── Header badges ───────── */

function LivePulse() {
  return (
    <span className="relative inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-300">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
      </span>
      Live
    </span>
  )
}

function ArchiveBadge({ date }: { date: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-600/30 bg-zinc-800/40 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
      <span className="inline-flex h-2 w-2 rounded-full bg-zinc-500" />
      {date}
    </span>
  )
}

/* ───────── Inline components for existing sections ───────── */

function SectionCard({ title, icon, badge, children, className, accent, actions }: {
  title: string; icon?: string; badge?: React.ReactNode; children: React.ReactNode; className?: string
  accent?: 'gold' | 'emerald' | 'amber' | 'red' | 'blue' | 'purple'
  actions?: React.ReactNode
}) {
  const accentColors = {
    gold: 'border-[#C9A84C]/20 shadow-[0_0_24px_rgba(201,168,76,0.04)]',
    emerald: 'border-emerald-500/20 shadow-[0_0_24px_rgba(16,185,129,0.04)]',
    amber: 'border-amber-500/20 shadow-[0_0_24px_rgba(245,158,11,0.04)]',
    red: 'border-red-500/20 shadow-[0_0_24px_rgba(239,68,68,0.04)]',
    blue: 'border-blue-500/20 shadow-[0_0_24px_rgba(59,130,246,0.04)]',
    purple: 'border-purple-500/20 shadow-[0_0_24px_rgba(168,85,247,0.04)]',
  }
  return (
    <div className={cn('rounded-2xl border bg-white/[0.02] backdrop-blur-xl overflow-hidden', accent ? accentColors[accent] : 'border-white/[0.06]', className)}>
      <div className="flex items-center gap-2 border-b border-white/[0.04] px-4 py-2.5">
        {icon && <span className="text-sm">{icon}</span>}
        <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/50">{title}</h3>
        {badge}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      <div className="p-3">{children}</div>
    </div>
  )
}

function FeedMessage({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false)
  const text = content ?? ''
  const needsMore = text.length > 120
  return (
    <div className="mt-1.5">
      <div className={cn(!expanded && needsMore && 'line-clamp-2')}>
        {expanded || !needsMore ? (
          <pre className="whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-white/80">{text}</pre>
        ) : (
          <span className="text-[11px] text-white/80">{text.slice(0, 120)}…</span>
        )}
      </div>
      {needsMore && (
        <button type="button" onClick={() => setExpanded(v => !v)} className="mt-1 text-[10px] font-semibold text-[#C9A84C] hover:text-[#E8C96A] transition-colors">
          {expanded ? '▴ কম' : '▾ আরও'}
        </button>
      )}
    </div>
  )
}

function AckBadge({ m }: { m: StaffMonitorRow }) {
  if (!tracksAck(m)) return null
  if (m.acknowledgedAt) return <span className="inline-flex items-center gap-1 rounded-md border border-emerald-400/25 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300">✓ {fmtTime(m.acknowledgedAt)}</span>
  if (m.status === 'delivered' || m.status === 'sent') return <span className="inline-flex items-center gap-1 rounded-md border border-amber-400/25 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-200">⏳ unseen</span>
  if (m.status === 'queued' || m.status === 'pending') return <span className="inline-flex items-center rounded-md border border-zinc-600/30 bg-white/5 px-1.5 py-0.5 text-[9px] text-zinc-400">sending…</span>
  return null
}

/* ───────── Types ───────── */

type HealthIssue = { severity: 'high' | 'medium' | 'low'; area: string; title: string; detail: string; signal?: string }
type HealthReport = { scannedAt: string; ok: boolean; issues: HealthIssue[]; summary: string }
type AutoFixAction = {
  id: string; status: string; summary: string; costEstimate: number
  payload: { title?: string; area?: string; severity?: string; stage?: string }
  createdAt: string; resolvedAt?: string; result?: { agentId?: string; status?: string; error?: string }
}
interface StaffCap { staffId: string; staffName: string; overallCompletionRate: number; strongTypes: string[]; weakTypes: string[] }

/* ───────── Main Component ───────── */

export default function AgentStaffMonitor() {
  const [liveData, setLiveData] = useState<StaffMonitorData | null>(null)
  const [historyData, setHistoryData] = useState<StaffMonitorData | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [deployMsg, setDeployMsg] = useState<string | null>(null)
  const [lastDeploy, setLastDeploy] = useState<string | null>(null)
  const [businessFilter, setBusinessFilter] = useState<'ALL' | 'ALMA_LIFESTYLE' | 'ALMA_TRADING'>('ALL')
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null)
  const [retriggering, setRetriggering] = useState(false)
  const [escalating, setEscalating] = useState<string | null>(null)

  // Sub-section state
  const [brainStats, setBrainStats] = useState<BrainStats | null>(null)
  const [trustRules, setTrustRules] = useState<TrustRule[]>([])
  const [healthReport, setHealthReport] = useState<HealthReport | null>(null)
  const [healthScanning, setHealthScanning] = useState(false)
  const [autoFixActions, setAutoFixActions] = useState<AutoFixAction[]>([])
  const [fixingIssue, setFixingIssue] = useState<string | null>(null)
  const [staffCaps, setStaffCaps] = useState<StaffCap[]>([])
  const [capsOpen, setCapsOpen] = useState(false)
  const [feedExpanded, setFeedExpanded] = useState(false)

  function showToast(msg: string, type: 'ok' | 'err') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  /* ── Data Loaders ── */

  const loadLive = useCallback(async (manual = false) => {
    if (manual) setSyncing(true)
    try {
      const maxAttempts = manual ? 3 : 2
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const res = await fetch('/api/agent/staff-monitor', { cache: 'no-store' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          setLiveData(await res.json() as StaffMonitorData)
          setErr(null)
          return
        } catch (e) {
          if (attempt < maxAttempts - 1) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue }
          if (!liveData) setErr(e instanceof Error ? e.message : 'load failed')
        }
      }
    } finally { if (manual) setSyncing(false) }
  }, [liveData])

  const loadHistoryDay = useCallback(async (date: string) => {
    setHistoryLoading(true); setSelectedDate(date)
    try {
      const res = await fetch(`/api/agent/staff-monitor?date=${encodeURIComponent(date)}`, { cache: 'no-store' })
      if (!res.ok) throw new Error('history load failed')
      setHistoryData(await res.json() as StaffMonitorData)
      setErr(null)
    } catch (e) { setErr(e instanceof Error ? e.message : 'history load failed') }
    finally { setHistoryLoading(false) }
  }, [])

  async function loadHealthScan() {
    setHealthScanning(true)
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch('/api/agent/health-scan', { cache: 'no-store' })
          if (res.ok) { setHealthReport(await res.json() as HealthReport); return }
          if (attempt === 0) { await new Promise(r => setTimeout(r, 2000)); continue }
        } catch { if (attempt === 0) { await new Promise(r => setTimeout(r, 2000)); continue } }
      }
    } finally { setHealthScanning(false) }
  }

  async function loadAutoFixActions() {
    try { const res = await fetch('/api/agent/auto-fix', { cache: 'no-store' }); if (res.ok) { const d = await res.json() as { actions: AutoFixAction[] }; setAutoFixActions(d.actions ?? []) } } catch { /* ignore */ }
  }

  async function loadBrainStats() {
    try { const res = await fetch('/api/agent/brain-stats', { cache: 'no-store' }); if (res.ok) setBrainStats(await res.json()) } catch { /* ignore */ }
  }

  async function loadTrustRules() {
    try { const res = await fetch('/api/agent/trust-rules', { cache: 'no-store' }); if (res.ok) { const data = await res.json(); setTrustRules(Array.isArray(data) ? data : data.rules ?? []) } } catch { /* ignore */ }
  }

  async function loadStaffCaps() {
    try { const res = await fetch('/api/agent/staff-capabilities', { cache: 'no-store' }); if (res.ok) setStaffCaps(await res.json()) } catch { /* ignore */ }
  }

  useEffect(() => {
    let alive = true
    void loadLive().then(() => { if (!alive) return })
    const t = setInterval(() => { if (alive) void loadLive() }, 10_000)
    fetch('/api/agent/vps/deploy', { cache: 'no-store' })
      .then(r => r.json())
      .then((d: { lastDeploy?: { ts?: string } }) => { if (alive && d?.lastDeploy?.ts) setLastDeploy(d.lastDeploy.ts) })
      .catch(() => {})
    return () => { alive = false; clearInterval(t) }
  }, [loadLive])

  useEffect(() => {
    if (!liveData) return
    void loadHealthScan(); void loadAutoFixActions(); void loadBrainStats(); void loadTrustRules(); void loadStaffCaps()
    const h = setInterval(() => { void loadHealthScan() }, 60_000)
    return () => clearInterval(h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!liveData])

  /* ── Actions ── */

  async function handleRetrigger(dutyKey: string) {
    const jobName = DUTY_TO_JOB[dutyKey]
    if (!jobName) { showToast('Unknown duty', 'err'); return }
    setRetriggering(true)
    try {
      const res = await fetch('/api/agent/staff-monitor/retrigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobName }) })
      const json = await res.json()
      if (res.ok) { const mode = json.mode === 'instant' ? 'instantly' : 'queued (~2 min)'; showToast(`✓ ${dutyKey} — ${mode}`, 'ok') }
      else showToast(json.message ?? 'Retrigger failed', 'err')
    } catch (e) { showToast(e instanceof Error ? e.message : 'Network error', 'err') }
    finally { setRetriggering(false) }
  }

  async function handleEscalate(m: StaffMonitorRow) {
    setEscalating(m.id)
    try {
      const res = await fetch('/api/agent/staff-monitor/escalate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staffName: m.staffName, messageType: typeLabel(m.type), outboxId: m.id }) })
      const json = await res.json() as { ok?: boolean; actions?: string[]; message?: string }
      if (res.ok) {
        const acts = json.actions ?? []
        const resent = acts.includes('resent_to_staff'); const ntfy = acts.includes('owner_ntfy_sent')
        showToast(resent && ntfy ? `✅ ${m.staffName} — re-sent + NTFY` : resent ? `✅ ${m.staffName} — re-sent` : `🔔 ${m.staffName} — NTFY sent`, 'ok')
      } else showToast(json.message ?? 'Escalation failed', 'err')
    } catch (e) { showToast(e instanceof Error ? e.message : 'Network error', 'err') }
    finally { setEscalating(null) }
  }

  async function handleDeploy() {
    setDeploying(true); setDeployMsg(null)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch('/api/agent/vps/deploy', { method: 'POST' })
        const json = await res.json().catch(() => ({})) as { ok?: boolean; steps?: Array<{ step: string; ok: boolean }>; healthCheck?: string; message?: string }
        if (res.ok || res.status === 207) {
          const stepLabels: Record<string, string> = { git_pull: 'Git Pull', npm_install: 'NPM Install', pm2_restart: 'PM2 Restart' }
          const summary = (json.steps ?? []).map(s => `${s.ok ? '✓' : '✗'} ${stepLabels[s.step] ?? s.step}`).join(' → ')
          const health = json.healthCheck ? ` · Health: ${json.healthCheck}` : ''
          setDeployMsg(json.ok ? `✓ ${summary}${health}` : `⚠ ${summary}${health}`)
          setLastDeploy(new Date().toISOString()); setDeploying(false)
          setTimeout(() => setDeployMsg(null), 10000); return
        }
        if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue }
        setDeployMsg(`✗ ${json.message ?? `Deploy failed (HTTP ${res.status})`}`)
      } catch (e) {
        if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue }
        setDeployMsg(`✗ ${e instanceof Error ? e.message : 'Network error'}`)
      }
    }
    setDeploying(false); setTimeout(() => setDeployMsg(null), 10000)
  }

  async function updateTrustTier(ruleId: string, newTier: string) {
    try {
      const res = await fetch('/api/agent/trust-rules', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ruleId, tier: newTier }) })
      if (res.ok) { showToast('Trust tier updated', 'ok'); void loadTrustRules() }
      else showToast('Update failed', 'err')
    } catch { showToast('Update failed', 'err') }
  }

  async function requestFix(issue: HealthIssue) {
    setFixingIssue(issue.title)
    try {
      const res = await fetch('/api/agent/auto-fix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issue }) })
      const d = await res.json() as { ok?: boolean; costEstimate?: number }
      if (d.ok) { showToast(`Auto-fix request created · ~$${(d.costEstimate ?? 0).toFixed(2)}`, 'ok'); void loadAutoFixActions() }
      else showToast('Auto-fix request failed', 'err')
    } catch { showToast('Network error', 'err') }
    finally { setFixingIssue(null) }
  }

  async function handleAutoFixDecision(actionId: string, decision: 'approve' | 'reject') {
    try {
      const res = await fetch('/api/agent/auto-fix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actionId, decision }) })
      if (res.ok) { showToast(decision === 'approve' ? '✅ Auto-Fix শুরু হচ্ছে...' : '❌ বাতিল', 'ok'); void loadAutoFixActions() }
    } catch { showToast('Failed', 'err') }
  }

  async function handleApproval(actionId: string, decision: 'approve' | 'reject') {
    try {
      const res = await fetch('/api/agent/staff-monitor/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actionId, decision }) })
      if (res.ok) showToast(decision === 'approve' ? '✓ Approved' : '✗ Rejected', 'ok')
      else showToast('Action failed', 'err')
    } catch { showToast('Network error', 'err') }
  }

  /* ── Derived State ── */

  const viewingHistory = Boolean(selectedDate && historyData)
  const rawDisplay = viewingHistory ? historyData : liveData
  const isLive = !viewingHistory

  const displayData = (() => {
    if (!rawDisplay) return null
    if (businessFilter === 'ALL') return rawDisplay
    const keep = (b: string | null | undefined) => (b ?? 'ALMA_LIFESTYLE') === businessFilter
    const feed = (rawDisplay.feed ?? []).filter(r => keep(r.businessId))
    const unacked = (rawDisplay.unackedMessages ?? []).filter(r => keep(r.businessId))
    const failures = (rawDisplay.failures ?? []).filter(r => keep(r.businessId))
    const staffFeedIds = new Set([...feed, ...unacked].map(r => r.staffId).filter(Boolean))
    const summaries = (rawDisplay.staffSummaries ?? []).filter(s => staffFeedIds.has(s.staffId))
    return { ...rawDisplay, feed, unackedMessages: unacked, failures, staffSummaries: summaries }
  })()

  /* ── Render: Error/Loading States ── */

  if (err && !displayData) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 p-6">
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] px-6 py-4 text-center text-sm text-red-300">
          লোড করা যায়নি: {err}
        </div>
        <button type="button" onClick={() => void loadLive()} className="rounded-xl border border-[#C9A84C]/30 bg-[#C9A84C]/[0.06] px-4 py-2 text-xs font-semibold text-[#C9A84C] hover:bg-[#C9A84C]/10 transition-all">
          আবার চেষ্টা
        </button>
      </div>
    )
  }

  if (!liveData) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="flex items-center gap-3 text-white/30">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[#C9A84C]/30 border-t-[#C9A84C]" />
          <span className="text-sm">Loading command center…</span>
        </div>
      </div>
    )
  }

  const feedItems = displayData?.feed ?? []
  const visibleFeed = feedExpanded ? feedItems : feedItems.slice(0, 6)

  /* ── Render: Main Layout ── */

  return (
    <div className="mx-auto flex max-w-7xl gap-0 pb-8 lg:gap-4 lg:p-4">
      <div className="min-w-0 flex-1 space-y-3 p-3 sm:p-4">
        {/* ── Header ── */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-black tracking-tight text-white/90">CC Camera Room</h1>
              {viewingHistory ? <ArchiveBadge date={selectedDate!} /> : <LivePulse />}
            </div>
            <p className="mt-1 text-[11px] text-white/25">
              {viewingHistory ? 'Viewing archive · press "Today" to return' : (
                <>{liveData.today} · auto-refresh 10s{liveData.generatedAt && <> · last {fmtTime(liveData.generatedAt)}</>}</>
              )}
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <div className="inline-flex rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-md p-0.5">
              {(['ALL', 'ALMA_LIFESTYLE', 'ALMA_TRADING'] as const).map(b => (
                <button key={b} type="button" onClick={() => setBusinessFilter(b)}
                  className={cn('rounded-lg px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-all',
                    businessFilter === b ? 'bg-[rgba(201,168,76,0.12)] text-[#E8C96A] shadow-[0_0_10px_rgba(201,168,76,0.08)]' : 'text-white/20 hover:text-white/40')}>
                  {b === 'ALL' ? 'All' : b === 'ALMA_LIFESTYLE' ? 'Life' : 'Trade'}
                </button>
              ))}
            </div>

            {viewingHistory ? (
              <button type="button" onClick={() => { setSelectedDate(null); setHistoryData(null) }}
                className="rounded-xl border border-[#C9A84C]/25 bg-[#C9A84C]/[0.06] px-3 py-1.5 text-[10px] font-bold text-[#C9A84C] transition-all hover:bg-[#C9A84C]/10">
                ← Today
              </button>
            ) : (
              <button type="button" onClick={() => void loadLive(true)} disabled={syncing}
                className={cn('rounded-xl border px-3 py-1.5 text-[10px] font-bold transition-all',
                  syncing ? 'border-white/[0.06] text-white/15' : 'border-[#C9A84C]/25 bg-[#C9A84C]/[0.06] text-[#C9A84C] hover:bg-[#C9A84C]/10')}>
                {syncing ? '…' : '↻ Sync'}
              </button>
            )}

            <button type="button" onClick={() => setHistoryOpen(v => !v)}
              className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-[10px] font-bold text-white/20 transition-all hover:text-white/40 lg:hidden">
              📅
            </button>

            <Link href="/agent" className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-[10px] font-bold text-white/20 transition-all hover:text-white/40">
              ← Chat
            </Link>
          </div>
        </div>

        {/* Deploy message */}
        {deployMsg && (
          <div className={cn('rounded-xl border px-4 py-2 text-[11px] font-semibold backdrop-blur-md',
            deployMsg.startsWith('✓') ? 'border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-300' : 'border-red-500/25 bg-red-500/[0.06] text-red-300')}>
            {deployMsg}
          </div>
        )}

        {/* Toast */}
        <AnimatePresence>
          {toast && (
            <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
              className={cn('fixed top-4 right-4 z-50 rounded-xl border px-4 py-2.5 text-[12px] font-semibold shadow-lg backdrop-blur-xl',
                toast.type === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-red-500/30 bg-red-500/10 text-red-300')}>
              {toast.msg}
            </motion.div>
          )}
        </AnimatePresence>

        {displayData && (
          <motion.div className="space-y-3" variants={staggerContainer} initial="hidden" animate="show">
            {/* ── Alert Panel ── */}
            <MonitorAlertPanel data={displayData} isLive={isLive} onEscalate={handleEscalate} escalating={escalating} />

            {/* ── KPI Strip ── */}
            <MonitorKPIStrip data={displayData} brainStats={brainStats} />

            {/* ── Quick Actions ── */}
            {isLive && (
              <MonitorQuickActions
                data={displayData}
                isLive={isLive}
                onDeploy={handleDeploy}
                deploying={deploying}
                lastDeploy={lastDeploy}
                onRetrigger={handleRetrigger}
                retriggering={retriggering}
                onApprove={handleApproval}
                onEscalateAll={async () => { for (const m of displayData.unackedMessages ?? []) await handleEscalate(m) }}
              />
            )}

            {/* ── Staff Cards ── */}
            <MonitorStaffCards staffSummaries={displayData.staffSummaries} />

            {/* ── Duty Timeline ── */}
            <MonitorDutyTimeline
              data={displayData.agentDuties}
              onRetrigger={handleRetrigger}
              retriggering={retriggering}
              isLive={isLive}
              dutyTimeOverrides={displayData.dutyTimeOverrides}
            />

            {/* ── Salah ── */}
            {isLive && <MonitorSalahTimeline salahDuties={displayData.salahDuties} />}

            {/* ── Brain + Trust side-by-side ── */}
            {isLive && (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <MonitorTrustEngine rules={trustRules} onUpdateTier={updateTrustTier} />
                <MonitorBrainCard stats={brainStats} />
              </div>
            )}

            {/* ── Health Scan ── */}
            {isLive && (
              <motion.div variants={fadeIn}>
                <SectionCard title="System Health" icon="🔍"
                  accent={healthReport?.ok ? 'emerald' : healthReport ? 'red' : undefined}
                  badge={healthReport && (
                    <span className={cn('rounded-md px-1.5 py-0.5 text-[9px] font-bold',
                      healthReport.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300')}>
                      {healthReport.ok ? '✅ Healthy' : `⚠️ ${healthReport.issues.length} issues`}
                    </span>
                  )}
                  actions={
                    <button type="button" disabled={healthScanning} onClick={() => void loadHealthScan()}
                      className={cn('rounded-lg border px-2 py-1 text-[9px] font-bold transition-all',
                        healthScanning ? 'border-white/[0.06] text-white/20' : 'border-[#C9A84C]/25 bg-[#C9A84C]/[0.06] text-[#C9A84C] hover:bg-[#C9A84C]/10')}>
                      {healthScanning ? '⏳ Scanning…' : '🔍 Scan Now'}
                    </button>
                  }
                >
                  {!healthReport ? (
                    <p className="py-2 text-[10px] text-white/20">Loading health scan…</p>
                  ) : healthReport.ok ? (
                    <div className="flex items-center gap-2 py-1 text-[11px] text-emerald-300/80">
                      <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
                      {healthReport.summary}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {healthReport.issues.map((issue, i) => (
                        <div key={i} className={cn('rounded-lg border p-2 text-[11px]',
                          issue.severity === 'high' ? 'border-red-500/20 bg-red-500/[0.04]' :
                          issue.severity === 'medium' ? 'border-amber-500/20 bg-amber-500/[0.04]' :
                          'border-white/[0.06] bg-white/[0.01]')}>
                          <div className="flex items-center gap-2">
                            <span className={cn('shrink-0 rounded px-1 py-0.5 text-[8px] font-bold uppercase',
                              issue.severity === 'high' ? 'bg-red-500/20 text-red-300' :
                              issue.severity === 'medium' ? 'bg-amber-500/20 text-amber-300' : 'bg-white/10 text-white/40')}>
                              {issue.severity}
                            </span>
                            <span className="font-semibold text-white/70">{issue.title}</span>
                          </div>
                          <div className="mt-1 flex items-center justify-between">
                            <p className="text-[10px] text-white/40">{issue.detail}</p>
                            {issue.severity === 'high' && (
                              <button type="button" disabled={fixingIssue === issue.title} onClick={() => void requestFix(issue)}
                                className={cn('ml-2 shrink-0 rounded-md border px-2 py-0.5 text-[9px] font-bold transition-all',
                                  fixingIssue === issue.title ? 'border-white/[0.06] text-white/20' : 'border-blue-400/30 bg-blue-400/[0.08] text-blue-300 hover:bg-blue-400/15')}>
                                {fixingIssue === issue.title ? '⏳...' : '🤖 Fix This'}
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </SectionCard>
              </motion.div>
            )}

            {/* ── Auto-Fix Pipeline ── */}
            {isLive && autoFixActions.length > 0 && (
              <motion.div variants={fadeIn}>
                <SectionCard title={`Auto-Fix Pipeline (${autoFixActions.length})`} icon="🤖" accent="blue"
                  actions={<button type="button" onClick={() => void loadAutoFixActions()} className="rounded-lg border border-blue-400/25 bg-blue-400/[0.06] px-2 py-1 text-[9px] font-bold text-blue-300 hover:bg-blue-400/10 transition-all">🔄 Refresh</button>}>
                  <div className="space-y-2">
                    {autoFixActions.map(a => {
                      const sc = a.status === 'pending' ? 'text-amber-300 bg-amber-500/15' : a.status === 'approved' || a.status === 'in_progress' ? 'text-blue-300 bg-blue-500/15' : a.status === 'completed' ? 'text-emerald-300 bg-emerald-500/15' : a.status === 'rejected' ? 'text-white/30 bg-white/5' : 'text-red-300 bg-red-500/15'
                      const sl = a.status === 'pending' ? '⏳ Approval Pending' : a.status === 'approved' ? '🚀 Dispatching...' : a.status === 'in_progress' ? '🤖 Working...' : a.status === 'completed' ? '✅ Fixed' : a.status === 'rejected' ? '❌ Rejected' : '⚠️ Failed'
                      return (
                        <div key={a.id} className="rounded-lg border border-white/[0.06] bg-white/[0.01] p-2.5 text-[11px]">
                          <div className="flex items-center gap-2">
                            <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[8px] font-bold', sc)}>{sl}</span>
                            <span className="font-semibold text-white/70 truncate">{a.payload?.title ?? 'Unknown'}</span>
                            <span className="ml-auto text-[9px] text-white/20">${(a.costEstimate ?? 0).toFixed(2)}</span>
                          </div>
                          {a.status === 'pending' && (
                            <div className="mt-1.5 flex gap-2">
                              <button type="button" onClick={() => void handleAutoFixDecision(a.id, 'approve')} className="rounded border border-emerald-400/30 bg-emerald-400/[0.08] px-2 py-0.5 text-[9px] font-bold text-emerald-300 hover:bg-emerald-400/15 transition-all">✅ Approve</button>
                              <button type="button" onClick={() => void handleAutoFixDecision(a.id, 'reject')} className="rounded border border-red-400/30 bg-red-400/[0.08] px-2 py-0.5 text-[9px] font-bold text-red-300 hover:bg-red-400/15 transition-all">❌ Reject</button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </SectionCard>
              </motion.div>
            )}

            {/* ── Staff Capabilities ── */}
            {isLive && staffCaps.length > 0 && (
              <motion.div variants={fadeIn}>
                <SectionCard title="স্টাফ সক্ষমতা" icon="📊" accent="emerald">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {staffCaps.map(sc => (
                      <div key={sc.staffId} className="rounded-lg border border-white/[0.04] bg-white/[0.01] px-3 py-2.5">
                        <div className="flex items-center justify-between">
                          <p className="text-[11px] font-bold text-white/70">{sc.staffName}</p>
                          <span className={cn('text-xs font-black tabular-nums',
                            sc.overallCompletionRate >= 80 ? 'text-emerald-400' : sc.overallCompletionRate >= 50 ? 'text-amber-400' : 'text-red-400')}>
                            {sc.overallCompletionRate}%
                          </span>
                        </div>
                        {sc.strongTypes.length > 0 && <p className="mt-1 text-[9px] text-emerald-400/60">💪 {sc.strongTypes.join(', ')}</p>}
                        {sc.weakTypes.length > 0 && <p className="mt-0.5 text-[9px] text-red-400/60">📈 {sc.weakTypes.join(', ')}</p>}
                      </div>
                    ))}
                  </div>
                </SectionCard>
              </motion.div>
            )}

            {/* ── Continuous Services ── */}
            {isLive && (displayData.continuousServices?.length ?? 0) > 0 && (
              <motion.div variants={fadeIn}>
                <SectionCard title={`Background Services (${displayData.continuousServices.length})`} icon="⚡" accent="blue">
                  <div className="flex flex-wrap gap-2">
                    {displayData.continuousServices.map(s => (
                      <span key={s.key} className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.04] bg-white/[0.01] px-2 py-1 text-[10px] text-white/40">
                        <span className={cn('inline-block h-1.5 w-1.5 rounded-full',
                          s.healthy ? 'bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.6)]' : 'bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.6)]')} />
                        {s.label}
                      </span>
                    ))}
                  </div>
                </SectionCard>
              </motion.div>
            )}

            {/* ── Unacked Messages ── */}
            {isLive && (displayData.unackedMessages?.length ?? 0) > 0 && (
              <motion.div variants={fadeIn}>
                <SectionCard title={`Pending Ack (${displayData.unackedMessages.length})`} icon="⏳" accent="amber"
                  actions={
                    <button type="button" disabled={escalating !== null}
                      onClick={async () => { for (const m of displayData.unackedMessages) await handleEscalate(m) }}
                      className="rounded-lg border border-red-500/25 bg-red-500/[0.06] px-2 py-1 text-[9px] font-bold text-red-300 transition-all hover:bg-red-500/10 disabled:opacity-40">
                      🔔 Notify All
                    </button>
                  }>
                  <div className="space-y-1.5">
                    {displayData.unackedMessages.map(m => (
                      <div key={m.id} className="rounded-lg border border-amber-500/10 bg-amber-500/[0.03] p-2 text-[11px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium text-amber-100/80">{m.staffName ?? '—'}</span>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <span className="rounded bg-amber-500/10 px-1 py-0.5 text-[9px] font-semibold text-amber-300">{typeLabel(m.type)}</span>
                            <span className="tabular-nums text-[10px] text-white/25">{m.sentAt ? fmtTime(m.sentAt) : fmtTime(m.createdAt)}</span>
                          </div>
                        </div>
                        <FeedMessage content={m.content ?? ''} />
                        <div className="mt-1.5 flex items-center justify-end">
                          <button type="button" disabled={escalating === m.id} onClick={() => handleEscalate(m)}
                            className={cn('rounded-md border px-2 py-1 text-[9px] font-bold transition-all',
                              escalating === m.id ? 'border-white/[0.06] text-white/20' : 'border-red-500/25 bg-red-500/[0.06] text-red-300 hover:bg-red-500/10')}>
                            {escalating === m.id ? '⏳…' : '🔔 Critical NTFY'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </SectionCard>
              </motion.div>
            )}

            {/* ── Pending Approvals ── */}
            {(displayData.pendingApprovals?.length ?? 0) > 0 && (
              <motion.div variants={fadeIn}>
                <SectionCard title="Pending Approvals (48h)" icon="⏳" accent="amber"
                  badge={<span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[9px] font-bold text-amber-300">{displayData.pendingApprovals!.length}</span>}>
                  <div className="space-y-1.5">
                    {displayData.pendingApprovals!.map(a => {
                      const ageH = (Date.now() - new Date(a.createdAt).getTime()) / 3_600_000
                      const ageColor = ageH > 12 ? 'border-red-500/20 bg-red-500/[0.03]' : ageH > 2 ? 'border-amber-500/20 bg-amber-500/[0.03]' : 'border-white/[0.06] bg-white/[0.01]'
                      return (
                        <div key={a.id} className={cn('rounded-lg border px-3 py-2', ageColor)}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="text-[10px] font-bold text-white/40">{a.type.replace(/_/g, ' ')}</p>
                              <p className="mt-0.5 text-[11px] text-white/50 line-clamp-2">{a.summary}</p>
                              <span className="text-[9px] text-white/20">{ageH < 1 ? `${Math.round(ageH * 60)}m ago` : `${ageH.toFixed(1)}h ago`}</span>
                            </div>
                            <div className="flex shrink-0 gap-1">
                              <button type="button" onClick={() => void handleApproval(a.id, 'approve')} className="rounded-lg border border-emerald-400/30 bg-emerald-500/[0.08] px-2.5 py-1 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/15">✓</button>
                              <button type="button" onClick={() => void handleApproval(a.id, 'reject')} className="rounded-lg border border-red-400/30 bg-red-500/[0.08] px-2.5 py-1 text-[10px] font-bold text-red-300 hover:bg-red-500/15">✗</button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </SectionCard>
              </motion.div>
            )}

            {/* ── Message Feed ── */}
            <motion.div variants={fadeIn}>
              <SectionCard title="Message Feed" icon="📨" accent="blue">
                {feedItems.length === 0 ? (
                  <p className="py-4 text-center text-[11px] text-white/20">কোনো মেসেজ লগ নেই</p>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      {visibleFeed.map(m => (
                        <div key={m.id} className={cn('flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-[11px] transition-all',
                          m.status === 'failed' ? 'bg-red-500/[0.04] border-l-2 border-l-red-400/50' :
                          m.status === 'delivered' ? 'bg-white/[0.01] border-l-2 border-l-emerald-400/30' :
                          'bg-white/[0.01] border-l-2 border-l-amber-400/25')}>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-white/60">{m.staffName ?? '—'}</span>
                              <span className="rounded bg-white/[0.04] px-1 py-0.5 text-[9px] font-semibold text-white/30">{typeLabel(m.type)}</span>
                              <AckBadge m={m} />
                              <span className="ml-auto shrink-0 tabular-nums text-[10px] text-white/20">{fmtTime(m.createdAt)}</span>
                            </div>
                            <FeedMessage content={m.content ?? ''} />
                          </div>
                        </div>
                      ))}
                    </div>
                    {feedItems.length > 6 && (
                      <button type="button" onClick={() => setFeedExpanded(v => !v)}
                        className="mt-2 w-full rounded-lg border border-white/[0.04] bg-white/[0.02] py-2 text-[10px] font-semibold text-white/30 transition-all hover:text-white/50 hover:border-[#C9A84C]/15">
                        {feedExpanded ? '▴ Show less' : `▾ Show all ${feedItems.length} messages`}
                      </button>
                    )}
                  </>
                )}
              </SectionCard>
            </motion.div>

            {/* ── Live Tasks & Reminders ── */}
            {((displayData.activeReminders?.length ?? 0) > 0 || (displayData.activeTodos?.length ?? 0) > 0) && (
              <motion.div variants={fadeIn}>
                <SectionCard title="Live Tasks & Reminders" icon="📌" accent="blue">
                  {(displayData.activeReminders?.length ?? 0) > 0 && (
                    <div className="mb-3">
                      <p className="text-[9px] font-bold uppercase tracking-wider text-white/25 mb-1.5">Reminders</p>
                      <div className="space-y-1">
                        {displayData.activeReminders!.map(r => (
                          <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.04] bg-white/[0.01] px-2.5 py-1.5">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className={cn('inline-block h-1.5 w-1.5 rounded-full', r.tier >= 3 ? 'bg-red-400' : r.tier >= 2 ? 'bg-amber-400' : 'bg-blue-400')} />
                                <span className="truncate text-[11px] font-medium text-white/60">{r.title}</span>
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <div className="text-[10px] font-medium text-white/40">{fmtTime(r.dueAt)}</div>
                              <div className={cn('text-[9px]', r.status === 'snoozed' ? 'text-amber-300/60' : r.status === 'sent' ? 'text-emerald-300/60' : 'text-white/20')}>{r.status}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {(displayData.activeTodos?.length ?? 0) > 0 && (
                    <div>
                      <p className="text-[9px] font-bold uppercase tracking-wider text-white/25 mb-1.5">Owner Todos</p>
                      <div className="space-y-1">
                        {displayData.activeTodos!.map(t => (
                          <div key={t.id} className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.04] bg-white/[0.01] px-2.5 py-1.5">
                            <span className="text-[11px] font-medium text-white/60 truncate">{t.title}</span>
                            <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-bold',
                              t.priority === 'high' ? 'bg-red-500/15 text-red-300' : t.priority === 'urgent' ? 'bg-red-500/20 text-red-200' : 'bg-white/5 text-white/30')}>
                              {t.priority}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </SectionCard>
              </motion.div>
            )}

            {/* ── Agent Capabilities ── */}
            <motion.div variants={fadeIn}>
              <SectionCard title="Agent Capabilities" icon="🧠" accent="purple"
                actions={<button type="button" onClick={() => setCapsOpen(v => !v)} className="text-[10px] font-bold text-white/25 hover:text-white/50 transition-colors">{capsOpen ? '▴ Hide' : '▾ Show'}</button>}>
                <AnimatePresence>
                  {capsOpen ? (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3 }} className="overflow-hidden">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {AGENT_CAPABILITIES.map(cap => (
                          <div key={cap.category} className="rounded-xl border border-white/[0.04] bg-white/[0.01] p-3">
                            <div className="mb-2 flex items-center gap-2">
                              <span>{cap.icon}</span>
                              <span className="text-[11px] font-bold text-white/60">{cap.category}</span>
                            </div>
                            <ul className="space-y-1.5">
                              {cap.items.map(item => (
                                <li key={item.name} className="flex items-start gap-1.5">
                                  <span className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-[#C9A84C]/40" />
                                  <div>
                                    <span className="text-[10px] text-white/35">{item.name}</span>
                                    <div className="text-[10px] text-white/40 mt-0.5">💬 {item.command}</div>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  ) : (
                    <p className="text-[10px] text-white/20">9 categories · ~100+ tools — ERP, Staff, Trading, Finance, Content, CS, Website, Personal, Diagnostics</p>
                  )}
                </AnimatePresence>
              </SectionCard>
            </motion.div>
          </motion.div>
        )}

        {!viewingHistory && (
          <div className="mt-4">
            <AgentSalahTimesSettings />
          </div>
        )}
      </div>

      {/* ── History Sidebar ── */}
      <aside className={cn(
        'shrink-0 lg:block lg:w-52 lg:rounded-2xl lg:border lg:border-white/[0.06] lg:bg-white/[0.02] lg:backdrop-blur-xl lg:p-3',
        historyOpen ? 'fixed inset-y-0 right-0 z-40 w-64 border-l border-white/[0.06] bg-[#08080A]/95 backdrop-blur-2xl p-4 shadow-[0_0_40px_rgba(0,0,0,0.6)]' : 'hidden',
      )}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/40">History</h2>
          <button type="button" onClick={() => setHistoryOpen(false)} className="text-xs text-white/20 hover:text-white/50 lg:hidden">✕</button>
        </div>
        <p className="mb-3 text-[10px] text-white/15">Last {liveData.feedDays ?? 7} days</p>
        <div className="space-y-0.5">
          <button type="button" onClick={() => { setSelectedDate(null); setHistoryData(null); setHistoryOpen(false) }}
            className={cn('w-full rounded-lg px-2.5 py-2 text-left text-[11px] font-medium transition-all',
              !viewingHistory ? 'bg-[rgba(201,168,76,0.1)] text-[#E8C96A]' : 'text-white/25 hover:bg-white/[0.03] hover:text-white/40')}>
            Today (live)
          </button>
          {(liveData.historyDates ?? []).map(date => (
            <button key={date} type="button" onClick={() => { void loadHistoryDay(date); setHistoryOpen(false) }}
              className={cn('w-full rounded-lg px-2.5 py-2 text-left text-[11px] font-medium tabular-nums transition-all',
                selectedDate === date ? 'bg-white/[0.05] text-white/70' : 'text-white/20 hover:bg-white/[0.03] hover:text-white/35')}>
              {date}{historyLoading && selectedDate === date ? ' …' : ''}
            </button>
          ))}
        </div>
      </aside>
    </div>
  )
}
