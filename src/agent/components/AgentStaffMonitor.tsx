'use client'

import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import type {
  StaffMonitorData,
  StaffSummary,
  StaffMonitorRow,
  AgentDutyRow,
  SalahDutyRow,
} from '@/agent/lib/staff-monitor-types'
import { DUTY_TO_JOB, AGENT_CAPABILITIES } from '@/agent/lib/staff-monitor-types'

const AgentSalahTimesSettings = dynamic(
  () => import('@/agent/components/AgentSalahTimesSettings'),
  { ssr: false, loading: () => null },
)

/* ───────── Constants ───────── */

const FEED_PREVIEW_LEN = 120

const TYPE_LABELS: Record<string, string> = {
  task_dispatch: 'টাস্ক',
  announcement: 'ঘোষণা',
  reminder: 'রিমাইন্ডার',
  presence: 'প্রেজেন্স',
  coaching: 'কোচিং',
  feedback_ack: 'ফিডব্যাক',
  task_redo: 'রিডু',
  proof_reminder: 'প্রমাণ',
}

function typeLabel(type: string) { return TYPE_LABELS[type] ?? type }

/* ───────── Primitives ───────── */

function FeedMessage({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false)
  const text = content ?? ''
  const needsMore = text.length > FEED_PREVIEW_LEN
  return (
    <div className="mt-1.5">
      <div className={cn(!expanded && needsMore && 'line-clamp-2')}>
        {expanded || !needsMore ? (
          <pre className="whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-white/80">{text}</pre>
        ) : (
          <span className="text-[11px] text-white/80">{text.slice(0, FEED_PREVIEW_LEN)}…</span>
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

function statusColor(s: StaffSummary): { dot: string; ring: string; bg: string } {
  if (s.failed > 0) return { dot: 'bg-red-400', ring: 'shadow-[0_0_8px_rgba(248,113,113,0.6)]', bg: 'border-red-500/25' }
  if (s.dispatched > 0 && s.delivered < s.dispatched) return { dot: 'bg-amber-400', ring: 'shadow-[0_0_8px_rgba(251,191,36,0.6)]', bg: 'border-amber-500/20' }
  if (s.tasksTotal > 0 && s.completionPct >= 100) return { dot: 'bg-emerald-400', ring: 'shadow-[0_0_8px_rgba(52,211,153,0.6)]', bg: 'border-emerald-500/20' }
  if (s.started) return { dot: 'bg-amber-400', ring: 'shadow-[0_0_8px_rgba(251,191,36,0.6)]', bg: 'border-amber-500/15' }
  return { dot: 'bg-zinc-500', ring: '', bg: 'border-white/[0.06]' }
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit' })
}

const ACK_TRACKED_TYPES = new Set(['task_dispatch', 'announcement', 'reminder', 'coaching', 'proof_reminder', 'task_redo', 'presence'])

function tracksAck(m: StaffMonitorRow): boolean {
  if (m.requiresAck) return true
  return ACK_TRACKED_TYPES.has(m.type) && (m.status === 'delivered' || m.status === 'sent' || !!m.acknowledgedAt)
}

function AckBadge({ m }: { m: StaffMonitorRow }) {
  if (!tracksAck(m)) return null
  if (m.acknowledgedAt) return <span className="inline-flex items-center gap-1 rounded-md border border-emerald-400/25 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300">✓ {fmtTime(m.acknowledgedAt)}</span>
  if (m.status === 'delivered' || m.status === 'sent') return <span className="inline-flex items-center gap-1 rounded-md border border-amber-400/25 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-200">⏳ unseen</span>
  if (m.status === 'queued' || m.status === 'pending') return <span className="inline-flex items-center rounded-md border border-zinc-600/30 bg-white/5 px-1.5 py-0.5 text-[9px] text-zinc-400">sending…</span>
  return null
}

/* ───────── Section wrapper ───────── */

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

/* ───────── Duty helpers ───────── */

function dutyIcon(status: AgentDutyRow['status']) {
  if (status === 'done') return <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
  if (status === 'failed' || status === 'missed') return <span className="inline-block h-2 w-2 rounded-full bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.6)]" />
  if (status === 'skipped') return <span className="inline-block h-2 w-2 rounded-full bg-zinc-500" />
  return <span className="inline-block h-2 w-2 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)] animate-pulse" />
}

function dutyRightText(d: AgentDutyRow): string {
  if (d.status === 'done' && d.ranAt) return fmtTime(d.ranAt)
  if (d.status === 'skipped' || d.status === 'missed') return d.detail || (d.status === 'missed' ? 'missed' : '')
  if (d.time) return d.time
  return ''
}

function salahIcon(status: SalahDutyRow['status']) {
  if (status === 'done') return <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
  if (status === 'missed') return <span className="inline-block h-2 w-2 rounded-full bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.6)]" />
  return <span className="inline-block h-2 w-2 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)] animate-pulse" />
}

/* ───────── Animation variants ───────── */

const fadeIn = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.3 } } }
const staggerContainer = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }

/* ───────── Duty detail + retrigger modal ───────── */

function DutyDetailPanel({ duty, onRetrigger, retriggering }: {
  duty: AgentDutyRow
  onRetrigger: (duty: string) => void
  retriggering: boolean
}) {
  const isFailed = duty.status === 'failed' || duty.status === 'missed'
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="overflow-hidden"
    >
      <div className={cn(
        'mx-2 mb-2 rounded-lg border px-3 py-2.5 text-[11px]',
        isFailed ? 'border-red-500/20 bg-red-500/[0.04]' : 'border-white/[0.06] bg-white/[0.02]',
      )}>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-white/40">
            <span className="font-semibold">Status:</span>
            <span className={cn(
              'rounded px-1.5 py-0.5 text-[10px] font-bold',
              duty.status === 'done' ? 'bg-emerald-500/15 text-emerald-300' :
              isFailed ? 'bg-red-500/15 text-red-300' :
              duty.status === 'skipped' ? 'bg-zinc-500/15 text-zinc-300' :
              'bg-amber-500/15 text-amber-300',
            )}>
              {duty.status.toUpperCase()}
            </span>
            {duty.ranAt && <span className="text-[10px] text-white/25">at {fmtTime(duty.ranAt)}</span>}
          </div>
          {duty.detail && (
            <div className={cn(
              'rounded-md border px-2.5 py-1.5',
              isFailed ? 'border-red-500/15 bg-red-500/[0.03] text-red-300/80' : 'border-white/[0.04] bg-white/[0.01] text-white/50',
            )}>
              <span className="text-[9px] font-bold uppercase tracking-wider text-white/25">Agent Feedback:</span>
              <p className="mt-0.5">{duty.detail}</p>
            </div>
          )}
          {!duty.detail && duty.status === 'done' && (
            <div className="text-[10px] text-white/20 italic">Completed — no detailed feedback logged</div>
          )}
          {!duty.detail && duty.status === 'pending' && (
            <div className="text-[10px] text-white/25 italic">Scheduled at {duty.time ?? '—'} — not yet run</div>
          )}
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            disabled={retriggering}
            onClick={() => onRetrigger(duty.duty)}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-[10px] font-bold transition-all',
              retriggering
                ? 'border-white/[0.06] text-white/20 cursor-wait'
                : isFailed
                  ? 'border-red-400/30 bg-red-500/[0.08] text-red-300 hover:bg-red-500/15'
                  : 'border-[#C9A84C]/30 bg-[#C9A84C]/[0.08] text-[#E8C96A] hover:bg-[#C9A84C]/15 hover:shadow-[0_0_12px_rgba(201,168,76,0.1)]',
            )}
          >
            {retriggering ? '⏳ Running…' : isFailed ? '⟳ Retrigger Now' : '⟳ Re-check Now'}
          </button>
          <span className="text-[9px] text-white/20">
            {isFailed ? 'Re-run this failed duty' : 'Force agent to re-run and get fresh data'}
          </span>
        </div>
      </div>
    </motion.div>
  )
}

/* ───────── Monitor Body ───────── */

type HealthIssue = { severity: 'high' | 'medium' | 'low'; area: string; title: string; detail: string; signal?: string }
type HealthReport = { scannedAt: string; ok: boolean; issues: HealthIssue[]; summary: string }
type AutoFixAction = {
  id: string; status: string; summary: string; costEstimate: number
  payload: { title?: string; area?: string; severity?: string; stage?: string }
  createdAt: string; resolvedAt?: string; result?: { agentId?: string; status?: string; error?: string }
}

function MonitorBody({ data, isLive }: { data: StaffMonitorData; isLive: boolean }) {
  const [feedExpanded, setFeedExpanded] = useState(false)
  const [expandedDuty, setExpandedDuty] = useState<string | null>(null)
  const [retriggering, setRetriggering] = useState(false)
  const [escalating, setEscalating] = useState<string | null>(null)
  const [capsOpen, setCapsOpen] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null)
  const [healthReport, setHealthReport] = useState<HealthReport | null>(null)
  const [healthScanning, setHealthScanning] = useState(false)
  const [autoFixActions, setAutoFixActions] = useState<AutoFixAction[]>([])
  const [fixingIssue, setFixingIssue] = useState<string | null>(null)
  const [editingDutyTime, setEditingDutyTime] = useState<string | null>(null)
  const [editTimeValue, setEditTimeValue] = useState('')
  const [savingTime, setSavingTime] = useState(false)

  const feedItems = data.feed ?? []
  const visibleFeed = feedExpanded ? feedItems : feedItems.slice(0, 6)

  const totalDuties = (data.agentDuties ?? []).length
  const doneDuties = (data.agentDuties ?? []).filter(d => d.status === 'done').length
  const failedDuties = (data.agentDuties ?? []).filter(d => d.status === 'failed' || d.status === 'missed').length

  const systemErrors = (data.warnings ?? []).filter(w => w.kind.startsWith('duty_') || w.kind === 'worker_heartbeat')
  const otherWarnings = (data.warnings ?? []).filter(w => !w.kind.startsWith('duty_') && w.kind !== 'worker_heartbeat')

  async function loadHealthScan() {
    setHealthScanning(true)
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch('/api/agent/health-scan', { cache: 'no-store' })
          if (res.ok) { setHealthReport(await res.json() as HealthReport); return }
          if (attempt === 0) { await new Promise(r => setTimeout(r, 2000)); continue }
        } catch {
          if (attempt === 0) { await new Promise(r => setTimeout(r, 2000)); continue }
        }
      }
    } finally {
      setHealthScanning(false)
    }
  }

  async function loadAutoFixActions() {
    try {
      const res = await fetch('/api/agent/auto-fix', { cache: 'no-store' })
      if (res.ok) {
        const d = await res.json() as { actions: AutoFixAction[] }
        setAutoFixActions(d.actions ?? [])
      }
    } catch { /* ignore */ }
  }

  async function requestFix(issue: HealthIssue) {
    setFixingIssue(issue.title)
    try {
      const res = await fetch('/api/agent/auto-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue }),
      })
      const d = await res.json() as { ok?: boolean; costEstimate?: number }
      if (d.ok) {
        showToast(`Auto-fix request created · ~$${(d.costEstimate ?? 0).toFixed(2)} · Telegram এ approve করুন`, 'ok')
        void loadAutoFixActions()
      } else {
        showToast('Auto-fix request failed', 'err')
      }
    } catch { showToast('Network error', 'err') }
    finally { setFixingIssue(null) }
  }

  async function handleAutoFixDecision(actionId: string, decision: 'approve' | 'reject') {
    try {
      const res = await fetch('/api/agent/auto-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId, decision }),
      })
      if (res.ok) {
        showToast(decision === 'approve' ? '✅ Auto-Fix শুরু হচ্ছে...' : '❌ বাতিল', 'ok')
        void loadAutoFixActions()
      }
    } catch { showToast('Failed', 'err') }
  }

  const [brainStats, setBrainStats] = useState<{
    memoryCount: number; activePlaybookCount: number; proposedPlaybookCount: number
    knowledgeCount: number; lastKnowledgeBuild: string | null; lastSessionSummary: string | null
    todayCostUsd: number
  } | null>(null)

  async function loadBrainStats() {
    try {
      const res = await fetch('/api/agent/brain-stats', { cache: 'no-store' })
      if (res.ok) setBrainStats(await res.json())
    } catch { /* ignore */ }
  }

  // Trust rules state
  interface TrustRule { id: string; domain: string; actionPattern: string; tier: string; approvalCount: number; rejectionCount: number; consecutiveApprovals: number }
  const [trustRules, setTrustRules] = useState<TrustRule[]>([])

  async function loadTrustRules() {
    try {
      const res = await fetch('/api/agent/trust-rules', { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setTrustRules(Array.isArray(data) ? data : data.rules ?? [])
      }
    } catch { /* ignore */ }
  }

  async function updateTrustTier(ruleId: string, newTier: string) {
    try {
      const res = await fetch('/api/agent/trust-rules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ruleId, tier: newTier }),
      })
      if (res.ok) {
        showToast('Trust tier updated', 'ok')
        void loadTrustRules()
      } else {
        showToast('Update failed', 'err')
      }
    } catch { showToast('Update failed', 'err') }
  }

  // Staff capabilities state
  interface StaffCap { staffId: string; staffName: string; overallCompletionRate: number; strongTypes: string[]; weakTypes: string[] }
  const [staffCaps, setStaffCaps] = useState<StaffCap[]>([])

  async function loadStaffCaps() {
    try {
      const res = await fetch('/api/agent/staff-capabilities', { cache: 'no-store' })
      if (res.ok) setStaffCaps(await res.json())
    } catch { /* ignore */ }
  }

  useEffect(() => {
    if (isLive && !healthReport) void loadHealthScan()
    if (isLive) void loadAutoFixActions()
    if (isLive) void loadBrainStats()
    if (isLive) void loadTrustRules()
    if (isLive) void loadStaffCaps()

    if (!isLive) return
    const healthInterval = setInterval(() => { void loadHealthScan() }, 60_000)
    return () => clearInterval(healthInterval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive])

  function showToast(msg: string, type: 'ok' | 'err') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  async function handleRetrigger(dutyKey: string) {
    const jobName = DUTY_TO_JOB[dutyKey]
    if (!jobName) { showToast('Unknown duty', 'err'); return }
    setRetriggering(true)
    try {
      const res = await fetch('/api/agent/staff-monitor/retrigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobName }),
      })
      const json = await res.json()
      if (res.ok) {
        const mode = json.mode === 'instant' ? 'instantly' : 'queued (~2 min)'
        showToast(`✓ ${dutyKey} — ${mode}`, 'ok')
      } else {
        showToast(json.message ?? 'Retrigger failed', 'err')
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Network error', 'err')
    } finally {
      setRetriggering(false)
    }
  }

  async function handleEscalate(m: StaffMonitorRow) {
    setEscalating(m.id)
    try {
      const res = await fetch('/api/agent/staff-monitor/escalate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffName: m.staffName, messageType: typeLabel(m.type), outboxId: m.id }),
      })
      const json = await res.json() as { ok?: boolean; actions?: string[]; message?: string }
      if (res.ok) {
        const acts = json.actions ?? []
        const resent = acts.includes('resent_to_staff')
        const ntfy = acts.includes('owner_ntfy_sent')
        showToast(
          resent && ntfy ? `✅ ${m.staffName} — message re-sent + NTFY alert sent`
            : resent ? `✅ ${m.staffName} — message re-sent to Telegram`
            : ntfy ? `🔔 ${m.staffName} — NTFY alert sent (resend failed)`
            : `⚠️ ${m.staffName} — action completed`,
          'ok',
        )
      } else {
        showToast(json.message ?? 'Escalation failed', 'err')
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Network error', 'err')
    } finally {
      setEscalating(null)
    }
  }

  return (
    <motion.div className="space-y-4" variants={staggerContainer} initial="hidden" animate="show">
      {/* Toast notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={cn(
              'fixed top-4 right-4 z-50 rounded-xl border px-4 py-2.5 text-[12px] font-semibold shadow-lg backdrop-blur-xl',
              toast.type === 'ok'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-red-500/30 bg-red-500/10 text-red-300',
            )}
          >
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── System Errors / Bugs ── */}
      {systemErrors.length > 0 && (
        <motion.div variants={fadeIn}>
          <SectionCard title={`System Issues (${systemErrors.length})`} icon="🐛" accent="red">
            <div className="space-y-2">
              {systemErrors.map((w, i) => (
                <div key={`${w.kind}-${i}`} className="rounded-lg border border-red-500/20 bg-red-500/[0.04] p-2.5 text-[11px]">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 text-red-400">{w.severity === 'critical' ? '🚨' : '⚠️'}</span>
                    <div className="flex-1">
                      <div className="font-semibold text-red-200/90">{w.message}</div>
                      <div className="mt-1 text-[10px] text-red-300/50">
                        {w.kind === 'worker_heartbeat' && 'Fix: SSH to VPS → pm2 restart agent-worker'}
                        {w.kind === 'duty_failed' && 'Click the failed duty above to see details and retrigger'}
                        {w.kind === 'duty_missed' && 'This duty was not run in its time window. Check worker logs.'}
                      </div>
                    </div>
                    <span className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase',
                      w.severity === 'critical' ? 'bg-red-500/20 text-red-300' : 'bg-amber-500/20 text-amber-300',
                    )}>
                      {w.severity}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
        </motion.div>
      )}

      {/* ── Other Warnings ── */}
      {otherWarnings.length > 0 && (
        <motion.div variants={fadeIn} className="space-y-2">
          {otherWarnings.map((w, i) => (
            <div
              key={`${w.kind}-${i}`}
              className={cn(
                'flex items-start gap-3 rounded-xl border px-4 py-3 text-[12px] backdrop-blur-md',
                w.severity === 'critical'
                  ? 'border-red-500/30 bg-red-500/[0.06] text-red-100 shadow-[0_0_20px_rgba(239,68,68,0.1)]'
                  : 'border-amber-500/25 bg-amber-500/[0.06] text-amber-100',
              )}
            >
              <span className="mt-0.5 text-lg">{w.severity === 'critical' ? '🚨' : '⚠️'}</span>
              <span className="flex-1">{w.message}</span>
            </div>
          ))}
        </motion.div>
      )}

      {/* ── KPI row ── */}
      <motion.div variants={fadeIn} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[
          { label: 'Agent Duties', value: `${doneDuties}/${totalDuties}`, sub: failedDuties > 0 ? `${failedDuties} failed` : 'on track', color: failedDuties > 0 ? 'text-red-400' : 'text-emerald-400' },
          { label: 'Staff Active', value: String(data.staffSummaries?.length ?? 0), sub: 'tracked today', color: 'text-[#E8C96A]' },
          { label: 'Unacked', value: String(data.unackedMessages?.length ?? 0), sub: 'pending', color: (data.unackedMessages?.length ?? 0) > 0 ? 'text-amber-400' : 'text-emerald-400' },
          { label: 'Failures', value: String(data.failures?.length ?? 0), sub: 'delivery', color: (data.failures?.length ?? 0) > 0 ? 'text-red-400' : 'text-emerald-400' },
          { label: 'AI Cost Today', value: brainStats ? `$${brainStats.todayCostUsd.toFixed(2)}` : '—', sub: 'USD', color: 'text-purple-400' },
        ].map(kpi => (
          <div key={kpi.label} className="rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-md px-3 py-2.5">
            <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-white/30">{kpi.label}</p>
            <p className={cn('mt-0.5 text-xl font-black tabular-nums', kpi.color)}>{kpi.value}</p>
            <p className="text-[10px] text-white/30">{kpi.sub}</p>
          </div>
        ))}
      </motion.div>

      {/* ── System Health ── */}
      {isLive && (
        <motion.div variants={fadeIn}>
          <SectionCard
            title="System Health"
            icon="🔍"
            accent={healthReport?.ok ? 'emerald' : healthReport ? 'red' : undefined}
            badge={healthReport && (
              <span className={cn(
                'rounded-md px-1.5 py-0.5 text-[9px] font-bold',
                healthReport.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300',
              )}>
                {healthReport.ok ? '✅ Healthy' : `⚠️ ${healthReport.issues.length} issues`}
              </span>
            )}
            actions={
              <button
                type="button"
                disabled={healthScanning}
                onClick={() => void loadHealthScan()}
                className={cn(
                  'rounded-lg border px-2 py-1 text-[9px] font-bold transition-all',
                  healthScanning
                    ? 'border-white/[0.06] text-white/20'
                    : 'border-[#C9A84C]/25 bg-[#C9A84C]/[0.06] text-[#C9A84C] hover:bg-[#C9A84C]/10',
                )}
              >
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
                {healthReport.scannedAt && <span className="ml-auto text-[9px] text-white/20">Scanned {fmtTime(healthReport.scannedAt)}</span>}
              </div>
            ) : (
              <div className="space-y-1.5">
                {healthReport.issues.map((issue, i) => (
                  <div key={i} className={cn(
                    'rounded-lg border p-2 text-[11px]',
                    issue.severity === 'high' ? 'border-red-500/20 bg-red-500/[0.04]' :
                    issue.severity === 'medium' ? 'border-amber-500/20 bg-amber-500/[0.04]' :
                    'border-white/[0.06] bg-white/[0.01]',
                  )}>
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        'shrink-0 rounded px-1 py-0.5 text-[8px] font-bold uppercase',
                        issue.severity === 'high' ? 'bg-red-500/20 text-red-300' :
                        issue.severity === 'medium' ? 'bg-amber-500/20 text-amber-300' :
                        'bg-white/10 text-white/40',
                      )}>
                        {issue.severity}
                      </span>
                      <span className="font-semibold text-white/70">{issue.title}</span>
                      <span className="ml-auto text-[9px] text-white/20">{issue.area}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <p className="text-[10px] text-white/40">{issue.detail}</p>
                      {issue.severity === 'high' && (
                        <button
                          type="button"
                          disabled={fixingIssue === issue.title}
                          onClick={() => void requestFix(issue)}
                          className={cn(
                            'ml-2 shrink-0 rounded-md border px-2 py-0.5 text-[9px] font-bold transition-all',
                            fixingIssue === issue.title
                              ? 'border-white/[0.06] text-white/20'
                              : 'border-blue-400/30 bg-blue-400/[0.08] text-blue-300 hover:bg-blue-400/15',
                          )}
                        >
                          {fixingIssue === issue.title ? '⏳...' : '🤖 Fix This'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                <p className="text-[9px] text-white/20">
                  Scanned {healthReport.scannedAt ? fmtTime(healthReport.scannedAt) : '—'}
                </p>
              </div>
            )}
          </SectionCard>
        </motion.div>
      )}

      {/* ── Auto-Fix Pipeline ── */}
      {isLive && (
        <motion.div variants={fadeIn}>
          <SectionCard
            title={`Auto-Fix Pipeline${autoFixActions.length > 0 ? ` (${autoFixActions.length})` : ''}`}
            icon="🤖"
            accent="blue"
            actions={
              <button type="button" onClick={() => void loadAutoFixActions()}
                className="rounded-lg border border-blue-400/25 bg-blue-400/[0.06] px-2 py-1 text-[9px] font-bold text-blue-300 hover:bg-blue-400/10 transition-all">
                🔄 Refresh
              </button>
            }
          >
            {autoFixActions.length === 0 ? (
              <p className="py-2 text-center text-[10px] text-white/20">
                কোনো অ্যাক্টিভ ফিক্স নেই — সিস্টেম প্রতি ১৫ মিনিটে স্ক্যান করছে
              </p>
            ) : (
            <div className="space-y-2">
              {autoFixActions.map(a => {
                const statusColor =
                  a.status === 'pending' ? 'text-amber-300 bg-amber-500/15' :
                  a.status === 'approved' || a.status === 'in_progress' ? 'text-blue-300 bg-blue-500/15' :
                  a.status === 'completed' ? 'text-emerald-300 bg-emerald-500/15' :
                  a.status === 'rejected' ? 'text-white/30 bg-white/5' :
                  'text-red-300 bg-red-500/15'
                const statusLabel =
                  a.status === 'pending' ? '⏳ Approval Pending' :
                  a.status === 'approved' ? '🚀 Dispatching...' :
                  a.status === 'in_progress' ? '🤖 Agent Working...' :
                  a.status === 'completed' ? '✅ Fixed' :
                  a.status === 'rejected' ? '❌ Rejected' : '⚠️ Failed'
                return (
                  <div key={a.id} className="rounded-lg border border-white/[0.06] bg-white/[0.01] p-2.5 text-[11px]">
                    <div className="flex items-center gap-2">
                      <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[8px] font-bold', statusColor)}>{statusLabel}</span>
                      <span className="font-semibold text-white/70 truncate">{a.payload?.title ?? 'Unknown'}</span>
                      <span className="ml-auto text-[9px] text-white/20">${(a.costEstimate ?? 0).toFixed(2)}</span>
                    </div>
                    {a.result?.agentId && <p className="mt-1 text-[9px] text-blue-300/50">Agent: {a.result.agentId}</p>}
                    {a.result?.error && <p className="mt-1 text-[9px] text-red-300/60">{a.result.error}</p>}
                    {a.status === 'pending' && (
                      <div className="mt-1.5 flex gap-2">
                        <button type="button" onClick={() => void handleAutoFixDecision(a.id, 'approve')}
                          className="rounded border border-emerald-400/30 bg-emerald-400/[0.08] px-2 py-0.5 text-[9px] font-bold text-emerald-300 hover:bg-emerald-400/15 transition-all">
                          ✅ Approve Fix
                        </button>
                        <button type="button" onClick={() => void handleAutoFixDecision(a.id, 'reject')}
                          className="rounded border border-red-400/30 bg-red-400/[0.08] px-2 py-0.5 text-[9px] font-bold text-red-300 hover:bg-red-400/15 transition-all">
                          ❌ Reject
                        </button>
                      </div>
                    )}
                    <p className="mt-1 text-[9px] text-white/15">{fmtTime(a.createdAt)}</p>
                  </div>
                )
              })}
            </div>
            )}
          </SectionCard>
        </motion.div>
      )}

      {/* ── Agent Brain ── */}
      {isLive && (
        <motion.div variants={fadeIn}>
          <SectionCard title="এজেন্ট ব্রেইন" icon="🧠" accent="purple">
            {!brainStats ? (
              <p className="py-2 text-[10px] text-white/20">Loading brain stats…</p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <div className="rounded-lg border border-white/[0.04] bg-white/[0.01] px-2.5 py-2">
                  <p className="text-[9px] font-bold uppercase tracking-wider text-white/25">Memories</p>
                  <p className="mt-0.5 text-lg font-black tabular-nums text-purple-300">{brainStats.memoryCount}</p>
                </div>
                <div className="rounded-lg border border-white/[0.04] bg-white/[0.01] px-2.5 py-2">
                  <p className="text-[9px] font-bold uppercase tracking-wider text-white/25">Active Rules</p>
                  <p className="mt-0.5 text-lg font-black tabular-nums text-emerald-300">{brainStats.activePlaybookCount}</p>
                </div>
                <div className="rounded-lg border border-white/[0.04] bg-white/[0.01] px-2.5 py-2">
                  <p className="text-[9px] font-bold uppercase tracking-wider text-white/25">Knowledge Facts</p>
                  <p className="mt-0.5 text-lg font-black tabular-nums text-blue-300">{brainStats.knowledgeCount}</p>
                </div>
                <div className="rounded-lg border border-white/[0.04] bg-white/[0.01] px-2.5 py-2">
                  <p className="text-[9px] font-bold uppercase tracking-wider text-white/25">Last Session Summary</p>
                  <p className="mt-0.5 text-[11px] tabular-nums text-white/40">
                    {brainStats.lastSessionSummary ? fmtTime(brainStats.lastSessionSummary) : '—'}
                  </p>
                </div>
                <div className="rounded-lg border border-white/[0.04] bg-white/[0.01] px-2.5 py-2">
                  <p className="text-[9px] font-bold uppercase tracking-wider text-white/25">Last Knowledge Build</p>
                  <p className="mt-0.5 text-[11px] tabular-nums text-white/40">
                    {brainStats.lastKnowledgeBuild ? fmtTime(brainStats.lastKnowledgeBuild) : '—'}
                  </p>
                </div>
                {brainStats.proposedPlaybookCount > 0 && (
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-2.5 py-2">
                    <p className="text-[9px] font-bold uppercase tracking-wider text-amber-300/50">Proposed Rules</p>
                    <p className="mt-0.5 text-lg font-black tabular-nums text-amber-300">{brainStats.proposedPlaybookCount}</p>
                    <p className="text-[9px] text-amber-300/40">awaiting approval</p>
                  </div>
                )}
              </div>
            )}
          </SectionCard>
        </motion.div>
      )}

      {/* ── Trust Engine ── */}
      {isLive && (
        <motion.div variants={fadeIn}>
          <SectionCard title="ট্রাস্ট ইঞ্জিন" icon="🛡️" accent="blue">
            {trustRules.length === 0 ? (
              <p className="py-2 text-[10px] text-white/30">কোনো trust rule নেই — agent approve হতে থাকলে auto-promote হবে</p>
            ) : (
              <div className="space-y-1.5">
                {trustRules.map(rule => (
                  <div key={rule.id} className="flex items-center gap-2 rounded-lg border border-white/[0.04] bg-white/[0.01] px-2.5 py-1.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] font-bold text-white/60">{rule.domain} / {rule.actionPattern}</p>
                      <p className="text-[9px] text-white/30">
                        ✅ {rule.approvalCount} approved · ❌ {rule.rejectionCount} rejected · 🔥 {rule.consecutiveApprovals} streak
                      </p>
                    </div>
                    <select
                      value={rule.tier}
                      onChange={(e) => updateTrustTier(rule.id, e.target.value)}
                      className={cn(
                        'rounded-md px-2 py-0.5 text-[10px] font-bold border cursor-pointer',
                        rule.tier === 'auto' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' :
                        rule.tier === 'notify' ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' :
                        'border-red-500/20 bg-red-500/[0.05] text-red-300',
                      )}
                    >
                      <option value="approve">🔒 Approve</option>
                      <option value="notify">📢 Notify</option>
                      <option value="auto">⚡ Auto</option>
                    </select>
                  </div>
                ))}
              </div>
            )}
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
                    <span className={cn(
                      'text-xs font-black tabular-nums',
                      sc.overallCompletionRate >= 80 ? 'text-emerald-400' :
                      sc.overallCompletionRate >= 50 ? 'text-amber-400' : 'text-red-400',
                    )}>
                      {sc.overallCompletionRate}%
                    </span>
                  </div>
                  {sc.strongTypes.length > 0 && (
                    <p className="mt-1 text-[9px] text-emerald-400/60">
                      💪 Strong: {sc.strongTypes.join(', ')}
                    </p>
                  )}
                  {sc.weakTypes.length > 0 && (
                    <p className="mt-0.5 text-[9px] text-red-400/60">
                      📈 Needs work: {sc.weakTypes.join(', ')}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </SectionCard>
        </motion.div>
      )}

      {/* ── Main 2-col grid ── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
        {/* Left — duties & salah (3/5) */}
        <div className="space-y-3 lg:col-span-3">
          <motion.div variants={fadeIn}>
            <SectionCard
              title={`Agent Duties (${totalDuties})`}
              icon="🤖"
              accent="gold"
              badge={
                <span className="rounded-md bg-[#C9A84C]/10 px-1.5 py-0.5 text-[9px] font-bold text-[#C9A84C]">
                  {doneDuties} done
                </span>
              }
            >
              <div className="space-y-0.5">
                {(data.agentDuties ?? []).map(d => {
                  const isFailed = d.status === 'failed' || d.status === 'missed'
                  const isExpanded = expandedDuty === d.duty
                  return (
                    <div key={d.id}>
                      <button
                        type="button"
                        onClick={() => setExpandedDuty(isExpanded ? null : d.duty)}
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] transition-all hover:bg-white/[0.03]',
                          isFailed
                            ? 'bg-red-500/[0.06] border-l-2 border-l-red-400/60'
                            : d.status === 'done'
                              ? 'bg-white/[0.01] border-l-2 border-l-emerald-400/40'
                              : 'bg-white/[0.01] border-l-2 border-l-amber-400/30',
                        )}
                      >
                        <span className="shrink-0">{dutyIcon(d.status)}</span>
                        <span className="min-w-0 flex-1 truncate text-white/80">{d.label}</span>
                        <span className="shrink-0">
                          {editingDutyTime === d.duty ? (
                            <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                              <input
                                type="time"
                                value={editTimeValue}
                                onChange={e => setEditTimeValue(e.target.value)}
                                className="rounded border border-[#C9A84C]/30 bg-transparent px-1.5 py-0.5 text-[10px] text-[#E8C96A] outline-none w-20"
                              />
                              <button
                                type="button"
                                disabled={savingTime}
                                onClick={async (e) => {
                                  e.stopPropagation()
                                  if (!editTimeValue) return
                                  setSavingTime(true)
                                  try {
                                    const res = await fetch('/api/agent/duty-time', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ dutyKey: d.duty, time: editTimeValue }),
                                    })
                                    if (res.ok) {
                                      setToast({ msg: `✓ ${d.label} time → ${editTimeValue}`, type: 'ok' })
                                      setEditingDutyTime(null)
                                    } else {
                                      const err = await res.json().catch(() => ({}))
                                      setToast({ msg: `✗ ${(err as {error?:string}).error ?? 'Save failed'}`, type: 'err' })
                                    }
                                  } catch {
                                    setToast({ msg: '✗ Network error', type: 'err' })
                                  } finally {
                                    setSavingTime(false)
                                    setTimeout(() => setToast(null), 4000)
                                  }
                                }}
                                className="rounded border border-emerald-400/30 bg-emerald-500/[0.08] px-1.5 py-0.5 text-[9px] font-bold text-emerald-300"
                              >
                                {savingTime ? '…' : '✓'}
                              </button>
                              <button
                                type="button"
                                onClick={e => { e.stopPropagation(); setEditingDutyTime(null) }}
                                className="text-[9px] text-white/20 hover:text-white/40"
                              >✕</button>
                            </div>
                          ) : (
                            <span className="group flex items-center gap-1">
                              <span className="text-[10px] font-medium tabular-nums text-white/30">{(data.dutyTimeOverrides ?? {})[d.duty] ?? dutyRightText(d)}</span>
                              {d.time && d.status === 'pending' && (
                                <button
                                  type="button"
                                  onClick={e => {
                                    e.stopPropagation()
                                    setEditingDutyTime(d.duty)
                                    setEditTimeValue((data.dutyTimeOverrides ?? {})[d.duty] ?? d.time ?? '')
                                  }}
                                  className="opacity-0 group-hover:opacity-100 text-[9px] text-white/15 hover:text-[#C9A84C] transition-all"
                                >✏️</button>
                              )}
                            </span>
                          )}
                        </span>
                        <span className={cn('shrink-0 text-[10px] text-white/15 transition-transform', isExpanded && 'rotate-180')}>▾</span>
                      </button>
                      <AnimatePresence>
                        {isExpanded && (
                          <DutyDetailPanel
                            duty={d}
                            onRetrigger={handleRetrigger}
                            retriggering={retriggering}
                          />
                        )}
                      </AnimatePresence>
                    </div>
                  )
                })}
              </div>
            </SectionCard>
          </motion.div>

          {isLive && (data.salahDuties?.length ?? 0) > 0 && (
            <motion.div variants={fadeIn}>
              <SectionCard title="Salah Reminders" icon="🕌" accent="emerald">
                <div className="space-y-1">
                  {data.salahDuties.map(s => (
                    <div key={s.waqt} className="flex items-center gap-2.5 rounded-lg bg-white/[0.01] px-2.5 py-2 text-[12px]">
                      <span className="shrink-0">{salahIcon(s.status)}</span>
                      <span className="min-w-0 flex-1 truncate text-white/80">
                        {s.label}
                        {s.reminders ? <span className="ml-1 text-[10px] text-white/30">({s.reminders}×)</span> : null}
                      </span>
                      <span className="shrink-0 text-[10px] font-medium tabular-nums text-white/30">
                        {s.status === 'done' && s.doneTime ? s.doneTime : s.scheduledTime}
                      </span>
                    </div>
                  ))}
                </div>
              </SectionCard>
            </motion.div>
          )}

          {/* Continuous services */}
          {isLive && (data.continuousServices?.length ?? 0) > 0 && (
            <motion.div variants={fadeIn}>
              <SectionCard title={`Background Services (${data.continuousServices.length})`} icon="⚡" accent="blue">
                <div className="flex flex-wrap gap-2">
                  {data.continuousServices.map(s => (
                    <span key={s.key} className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.04] bg-white/[0.01] px-2 py-1 text-[10px] text-white/40">
                      <span className={cn(
                        'inline-block h-1.5 w-1.5 rounded-full',
                        s.healthy ? 'bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.6)]' : 'bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.6)]',
                      )} />
                      {s.label}
                    </span>
                  ))}
                </div>
                {data.schedulerHealth?.ackEscalationLastRun && (
                  <div className="mt-2 text-[10px] text-white/20">
                    Last ack escalation: {fmtTime(data.schedulerHealth.ackEscalationLastRun)}
                  </div>
                )}
              </SectionCard>
            </motion.div>
          )}
        </div>

        {/* Right — staff cards + unacked (2/5) */}
        <div className="space-y-3 lg:col-span-2">
          {(data.staffSummaries?.length ?? 0) > 0 && (
            <motion.div variants={fadeIn}>
              <SectionCard title="Staff Overview" icon="👥" accent="gold">
                <div className="space-y-2">
                  {data.staffSummaries.map(s => {
                    const sc = statusColor(s)
                    return (
                      <div key={s.staffId} className={cn('rounded-xl border bg-white/[0.02] p-3', sc.bg)}>
                        <div className="flex items-center gap-2">
                          <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', sc.dot, sc.ring)} />
                          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white/90">{s.staffName}</span>
                          <span className="text-[12px] font-bold tabular-nums text-white/50">{s.completionPct}%</span>
                        </div>
                        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
                          <motion.div
                            className="h-full rounded-full bg-gradient-to-r from-[#8B6914] via-[#C9A84C] to-[#E8C96A]"
                            initial={{ width: 0 }}
                            animate={{ width: `${Math.min(s.completionPct, 100)}%` }}
                            transition={{ duration: 0.8, ease: 'easeOut' }}
                          />
                        </div>
                        <div className="mt-2 flex gap-3 text-[10px] text-white/30">
                          <span>📤 {s.dispatched}</span>
                          <span>✓ {s.delivered}</span>
                          {s.failed > 0 && <span className="text-red-400">✗ {s.failed}</span>}
                          <span className="ml-auto">🎯 {s.tasksDone}/{s.tasksTotal}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </SectionCard>
            </motion.div>
          )}

          {/* Unacked messages with re-notify */}
          {isLive && (data.unackedMessages?.length ?? 0) > 0 && (
            <motion.div variants={fadeIn}>
              <SectionCard
                title={`Pending Ack (${data.unackedMessages.length})`}
                icon="⏳"
                accent="amber"
                actions={
                  <button
                    type="button"
                    disabled={escalating !== null}
                    onClick={async () => {
                      for (const m of data.unackedMessages) {
                        await handleEscalate(m)
                      }
                    }}
                    className="rounded-lg border border-red-500/25 bg-red-500/[0.06] px-2 py-1 text-[9px] font-bold text-red-300 transition-all hover:bg-red-500/10 disabled:opacity-40"
                  >
                    🔔 Notify All
                  </button>
                }
              >
                <div className="space-y-1.5">
                  {data.unackedMessages.map(m => (
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
                        <button
                          type="button"
                          disabled={escalating === m.id}
                          onClick={() => handleEscalate(m)}
                          className={cn(
                            'rounded-md border px-2 py-1 text-[9px] font-bold transition-all',
                            escalating === m.id
                              ? 'border-white/[0.06] text-white/20'
                              : 'border-red-500/25 bg-red-500/[0.06] text-red-300 hover:bg-red-500/10',
                          )}
                        >
                          {escalating === m.id ? '⏳…' : '🔔 Critical NTFY'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </SectionCard>
            </motion.div>
          )}
        </div>
      </div>

      {/* ── Delivery Failures ── */}
      {(data.failures?.length ?? 0) > 0 && (
        <motion.div variants={fadeIn}>
          <SectionCard
            title={`Delivery Failures (${data.failures.length})`}
            icon="❌"
            accent="red"
          >
            <div className="space-y-1.5">
              {data.failures.map(f => (
                <div key={f.id} className="rounded-lg border border-red-500/15 bg-red-500/[0.03] p-2 text-[11px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-red-200/80">{f.staffName ?? 'Unknown'}</span>
                    <div className="flex items-center gap-1.5">
                      <span className="rounded bg-red-500/15 px-1 py-0.5 text-[9px] font-semibold text-red-300">{typeLabel(f.type)}</span>
                      <span className="tabular-nums text-[10px] text-white/20">{f.sentAt ? fmtTime(f.sentAt) : fmtTime(f.createdAt)}</span>
                    </div>
                  </div>
                  {f.errorReason && (
                    <p className="mt-1 text-[10px] text-red-300/60">⚠ {f.errorReason}</p>
                  )}
                </div>
              ))}
            </div>
          </SectionCard>
        </motion.div>
      )}

      {/* ── Type counts ── */}
      {Object.keys(data.typeCounts ?? {}).length > 0 && (
        <motion.div variants={fadeIn} className="flex flex-wrap gap-2 px-1">
          {Object.entries(data.typeCounts).map(([t, n]) => (
            <span key={t} className="rounded-md border border-white/[0.04] bg-white/[0.02] px-2 py-1 text-[10px] font-medium text-white/25">
              {typeLabel(t)} <span className="text-white/50">{n}</span>
            </span>
          ))}
        </motion.div>
      )}

      {/* ── Message feed ── */}
      <motion.div variants={fadeIn}>
        <SectionCard title="Message Feed" icon="📨" accent="blue">
          {feedItems.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-white/20">কোনো মেসেজ লগ নেই</p>
          ) : (
            <>
              <div className="space-y-1.5">
                {visibleFeed.map(m => (
                  <div
                    key={m.id}
                    className={cn(
                      'flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-[11px] transition-all',
                      m.status === 'failed'
                        ? 'bg-red-500/[0.04] border-l-2 border-l-red-400/50'
                        : m.status === 'delivered'
                          ? 'bg-white/[0.01] border-l-2 border-l-emerald-400/30'
                          : 'bg-white/[0.01] border-l-2 border-l-amber-400/25',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-white/60">{m.staffName ?? '—'}</span>
                        <span className="rounded bg-white/[0.04] px-1 py-0.5 text-[9px] font-semibold text-white/30">{typeLabel(m.type)}</span>
                        <AckBadge m={m} />
                        <span className="ml-auto shrink-0 tabular-nums text-[10px] text-white/20">{fmtTime(m.createdAt)}</span>
                      </div>
                      <FeedMessage content={m.content ?? ''} />
                      {m.errorReason && <div className="mt-1 text-[10px] text-red-300">⚠ {m.errorReason}</div>}
                    </div>
                  </div>
                ))}
              </div>
              {feedItems.length > 6 && (
                <button
                  type="button"
                  onClick={() => setFeedExpanded(v => !v)}
                  className="mt-2 w-full rounded-lg border border-white/[0.04] bg-white/[0.02] py-2 text-[10px] font-semibold text-white/30 transition-all hover:text-white/50 hover:border-[#C9A84C]/15"
                >
                  {feedExpanded ? '▴ Show less' : `▾ Show all ${feedItems.length} messages`}
                </button>
              )}
            </>
          )}
        </SectionCard>
      </motion.div>

      {/* ── Agent Capabilities ── */}
      <motion.div variants={fadeIn}>
        <SectionCard
          title="Agent Capabilities"
          icon="🧠"
          accent="purple"
          actions={
            <button
              type="button"
              onClick={() => setCapsOpen(v => !v)}
              className="text-[10px] font-bold text-white/25 hover:text-white/50 transition-colors"
            >
              {capsOpen ? '▴ Hide' : '▾ Show'}
            </button>
          }
        >
          <AnimatePresence>
            {capsOpen ? (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="overflow-hidden"
              >
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
                <div className="mt-3 rounded-lg border border-white/[0.04] bg-white/[0.01] px-3 py-2 text-center text-[10px] text-white/20">
                  Total: ~100+ tools across 9 categories · চ্যাটে যেকোনো কাজ বলুন, agent handle করবে
                </div>
              </motion.div>
            ) : (
              <p className="text-[10px] text-white/20">
                9 categories · ~100+ tools — ERP, Staff, Trading, Finance, Content, CS, Website, Personal, Diagnostics
              </p>
            )}
          </AnimatePresence>
        </SectionCard>
      </motion.div>

      {/* Live Tasks & Reminders */}
      {((data.activeReminders?.length ?? 0) > 0 || (data.activeTodos?.length ?? 0) > 0) && (
        <motion.div variants={fadeIn}>
          <SectionCard title="Live Tasks & Reminders" icon="📌" accent="blue">
            {(data.activeReminders?.length ?? 0) > 0 && (
              <div className="mb-3">
                <p className="text-[9px] font-bold uppercase tracking-wider text-white/25 mb-1.5">Reminders</p>
                <div className="space-y-1">
                  {data.activeReminders!.map(r => (
                    <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.04] bg-white/[0.01] px-2.5 py-1.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={cn('inline-block h-1.5 w-1.5 rounded-full', r.tier >= 3 ? 'bg-red-400' : r.tier >= 2 ? 'bg-amber-400' : 'bg-blue-400')} />
                          <span className="truncate text-[11px] font-medium text-white/60">{r.title}</span>
                          {r.isRecurring && <span className="text-[9px] text-white/20">🔁</span>}
                        </div>
                        {r.body && <p className="mt-0.5 truncate text-[10px] text-white/25">{r.body}</p>}
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-[10px] font-medium text-white/40">{fmtTime(r.dueAt)}</div>
                        <div className={cn('text-[9px]', r.status === 'snoozed' ? 'text-amber-300/60' : r.status === 'sent' ? 'text-emerald-300/60' : 'text-white/20')}>
                          {r.status}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {(data.activeTodos?.length ?? 0) > 0 && (
              <div>
                <p className="text-[9px] font-bold uppercase tracking-wider text-white/25 mb-1.5">Owner Todos</p>
                <div className="space-y-1">
                  {data.activeTodos!.map(t => (
                    <div key={t.id} className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.04] bg-white/[0.01] px-2.5 py-1.5">
                      <div className="min-w-0 flex-1">
                        <span className="text-[11px] font-medium text-white/60">{t.title}</span>
                        {t.detail && <p className="mt-0.5 truncate text-[10px] text-white/25">{t.detail}</p>}
                      </div>
                      <div className="shrink-0">
                        <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-bold',
                          t.priority === 'high' ? 'bg-red-500/15 text-red-300' :
                          t.priority === 'urgent' ? 'bg-red-500/20 text-red-200' :
                          'bg-white/5 text-white/30'
                        )}>{t.priority}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </SectionCard>
        </motion.div>
      )}

      {/* Pending Approvals */}
      {(data.pendingApprovals?.length ?? 0) > 0 && (
        <motion.div variants={fadeIn}>
          <SectionCard title="Pending Approvals (48h)" icon="⏳" accent="amber"
            badge={<span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[9px] font-bold text-amber-300">{data.pendingApprovals!.length}</span>}
          >
            <div className="space-y-1.5">
              {data.pendingApprovals!.map(a => {
                const ageMs = Date.now() - new Date(a.createdAt).getTime()
                const ageH = ageMs / 3_600_000
                const ageColor = ageH > 12 ? 'border-red-500/20 bg-red-500/[0.03]' : ageH > 2 ? 'border-amber-500/20 bg-amber-500/[0.03]' : 'border-white/[0.06] bg-white/[0.01]'
                return (
                  <div key={a.id} className={cn('rounded-lg border px-3 py-2', ageColor)}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-bold text-white/40">{a.type.replace(/_/g, ' ')}</span>
                          {a.status === 'waiting_list' && <span className="rounded bg-red-500/20 px-1 py-0.5 text-[8px] font-bold text-red-300">WAITING</span>}
                        </div>
                        <p className="mt-0.5 text-[11px] text-white/50 line-clamp-2">{a.summary}</p>
                        <div className="mt-1 flex items-center gap-2 text-[9px] text-white/20">
                          <span>{fmtTime(a.createdAt)}</span>
                          <span>·</span>
                          <span>{ageH < 1 ? `${Math.round(ageH * 60)}m ago` : `${ageH.toFixed(1)}h ago`}</span>
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const res = await fetch('/api/agent/staff-monitor/approve', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ actionId: a.id, decision: 'approve' }),
                              })
                              if (res.ok) setToast({ msg: '✓ Approved', type: 'ok' })
                              else setToast({ msg: 'Approve failed', type: 'err' })
                            } catch { setToast({ msg: 'Network error', type: 'err' }) }
                            setTimeout(() => setToast(null), 3000)
                          }}
                          className="rounded-lg border border-emerald-400/30 bg-emerald-500/[0.08] px-2.5 py-1 text-[10px] font-bold text-emerald-300 transition-all hover:bg-emerald-500/15"
                        >
                          ✓
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const res = await fetch('/api/agent/staff-monitor/approve', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ actionId: a.id, decision: 'reject' }),
                              })
                              if (res.ok) setToast({ msg: '✗ Rejected', type: 'ok' })
                              else setToast({ msg: 'Reject failed', type: 'err' })
                            } catch { setToast({ msg: 'Network error', type: 'err' }) }
                            setTimeout(() => setToast(null), 3000)
                          }}
                          className="rounded-lg border border-red-400/30 bg-red-500/[0.08] px-2.5 py-1 text-[10px] font-bold text-red-300 transition-all hover:bg-red-500/15"
                        >
                          ✗
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </SectionCard>
        </motion.div>
      )}
    </motion.div>
  )
}

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
          if (attempt < maxAttempts - 1) {
            await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
            continue
          }
          // Only show error if no data loaded yet — stale data is better than error screen
          if (!liveData) setErr(e instanceof Error ? e.message : 'load failed')
        }
      }
    } finally {
      if (manual) setSyncing(false)
    }
  }, [liveData])

  const loadHistoryDay = useCallback(async (date: string) => {
    setHistoryLoading(true)
    setSelectedDate(date)
    try {
      const res = await fetch(`/api/agent/staff-monitor?date=${encodeURIComponent(date)}`, { cache: 'no-store' })
      if (!res.ok) throw new Error('history load failed')
      setHistoryData(await res.json() as StaffMonitorData)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'history load failed')
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    let alive = true
    void loadLive().then(() => { if (!alive) return })
    const t = setInterval(() => { if (alive) void loadLive() }, 10_000)
    fetch('/api/agent/vps/deploy', { cache: 'no-store' })
      .then(r => r.json())
      .then((d: { lastDeploy?: { ts?: string } }) => {
        if (alive && d?.lastDeploy?.ts) setLastDeploy(d.lastDeploy.ts)
      })
      .catch(() => {})
    return () => { alive = false; clearInterval(t) }
  }, [loadLive])

  const viewingHistory = Boolean(selectedDate && historyData)
  const rawDisplay = viewingHistory ? historyData : liveData

  const displayData = (() => {
    if (!rawDisplay) return null
    if (businessFilter === 'ALL') return rawDisplay
    const keep = (b: string | null | undefined) => (b ?? 'ALMA_LIFESTYLE') === businessFilter
    const feed = (rawDisplay.feed ?? []).filter(r => keep(r.businessId))
    const unacked = (rawDisplay.unackedMessages ?? []).filter(r => keep(r.businessId))
    const failures = (rawDisplay.failures ?? []).filter(r => keep(r.businessId))
    const stafffeedIds = new Set([...feed, ...unacked].map(r => r.staffId).filter(Boolean))
    const summaries = (rawDisplay.staffSummaries ?? []).filter(s => stafffeedIds.has(s.staffId))
    return { ...rawDisplay, feed, unackedMessages: unacked, failures, staffSummaries: summaries }
  })()

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
          <span className="text-sm">Loading monitor…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-6xl gap-0 pb-8 lg:gap-4 lg:p-4">
      <div className="min-w-0 flex-1 space-y-4 p-3 sm:p-4">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-black tracking-tight text-white/90">LIVE Business</h1>
              {viewingHistory ? <ArchiveBadge date={selectedDate!} /> : <LivePulse />}
            </div>
            <p className="mt-1 text-[11px] text-white/25">
              {viewingHistory
                ? 'Viewing archive · press "Today" to return'
                : (
                  <>
                    {liveData.today} · auto-refresh 10s
                    {liveData.generatedAt && <> · last {fmtTime(liveData.generatedAt)}</>}
                  </>
                )}
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <div className="inline-flex rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-md p-0.5">
              {(['ALL', 'ALMA_LIFESTYLE', 'ALMA_TRADING'] as const).map(b => (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBusinessFilter(b)}
                  className={cn(
                    'rounded-lg px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-all',
                    businessFilter === b
                      ? 'bg-[rgba(201,168,76,0.12)] text-[#E8C96A] shadow-[0_0_10px_rgba(201,168,76,0.08)]'
                      : 'text-white/20 hover:text-white/40',
                  )}
                >
                  {b === 'ALL' ? 'All' : b === 'ALMA_LIFESTYLE' ? 'Life' : 'Trade'}
                </button>
              ))}
            </div>

            {viewingHistory ? (
              <button
                type="button"
                onClick={() => { setSelectedDate(null); setHistoryData(null) }}
                className="rounded-xl border border-[#C9A84C]/25 bg-[#C9A84C]/[0.06] px-3 py-1.5 text-[10px] font-bold text-[#C9A84C] transition-all hover:bg-[#C9A84C]/10"
              >
                ← Today
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void loadLive(true)}
                disabled={syncing}
                className={cn(
                  'rounded-xl border px-3 py-1.5 text-[10px] font-bold transition-all',
                  syncing
                    ? 'border-white/[0.06] text-white/15'
                    : 'border-[#C9A84C]/25 bg-[#C9A84C]/[0.06] text-[#C9A84C] hover:bg-[#C9A84C]/10',
                )}
              >
                {syncing ? '…' : '↻ Sync'}
              </button>
            )}

            <button
              type="button"
              onClick={() => setHistoryOpen(v => !v)}
              className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-[10px] font-bold text-white/20 transition-all hover:text-white/40 lg:hidden"
            >
              📅
            </button>

            <button
              type="button"
              disabled={deploying}
              onClick={async () => {
                setDeploying(true)
                setDeployMsg(null)
                for (let attempt = 0; attempt < 3; attempt++) {
                  try {
                    const res = await fetch('/api/agent/vps/deploy', { method: 'POST' })
                    const json = await res.json().catch(() => ({})) as { ok?: boolean; steps?: Array<{ step: string; ok: boolean }>; healthCheck?: string; message?: string }
                    if (res.ok || res.status === 207) {
                      const stepLabels: Record<string, string> = { git_pull: 'Git Pull', npm_install: 'NPM Install', pm2_restart: 'PM2 Restart' }
                      const summary = (json.steps ?? []).map(s =>
                        `${s.ok ? '✓' : '✗'} ${stepLabels[s.step] ?? s.step}`
                      ).join(' → ')
                      const health = json.healthCheck ? ` · Health: ${json.healthCheck}` : ''
                      setDeployMsg(json.ok ? `✓ ${summary}${health}` : `⚠ ${summary}${health}`)
                      setLastDeploy(new Date().toISOString())
                      setDeploying(false)
                      setTimeout(() => setDeployMsg(null), 10000)
                      return
                    }
                    if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue }
                    setDeployMsg(`✗ ${json.message ?? `Deploy failed (HTTP ${res.status})`}`)
                  } catch (e) {
                    if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue }
                    setDeployMsg(`✗ ${e instanceof Error ? e.message : 'Network error'} — check VPS connectivity`)
                  }
                }
                setDeploying(false)
                setTimeout(() => setDeployMsg(null), 10000)
              }}
              className={cn(
                'rounded-xl border px-3 py-1.5 text-[10px] font-bold transition-all',
                deploying
                  ? 'border-white/[0.06] text-white/15'
                  : 'border-purple-500/25 bg-purple-500/[0.06] text-purple-300 hover:bg-purple-500/10',
              )}
            >
              {deploying ? '⏳ Deploying…' : '🚀 Deploy Worker'}
            </button>
            {lastDeploy && (
              <span className="text-[9px] text-white/15" title={lastDeploy}>
                Last: {fmtTime(lastDeploy)}
              </span>
            )}

            <Link
              href="/agent"
              className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-[10px] font-bold text-white/20 transition-all hover:text-white/40"
            >
              ← Chat
            </Link>
          </div>
        </div>

        {deployMsg && (
          <div className={cn(
            'rounded-xl border px-4 py-2 text-[11px] font-semibold backdrop-blur-md',
            deployMsg.startsWith('✓')
              ? 'border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-300'
              : 'border-red-500/25 bg-red-500/[0.06] text-red-300',
          )}>
            {deployMsg}
          </div>
        )}

        {displayData && <MonitorBody data={displayData} isLive={!viewingHistory} />}

        {!viewingHistory && (
          <div className="mt-4">
            <AgentSalahTimesSettings />
          </div>
        )}
      </div>

      {/* History sidebar */}
      <aside
        className={cn(
          'shrink-0 lg:block lg:w-52 lg:rounded-2xl lg:border lg:border-white/[0.06] lg:bg-white/[0.02] lg:backdrop-blur-xl lg:p-3',
          historyOpen ? 'fixed inset-y-0 right-0 z-40 w-64 border-l border-white/[0.06] bg-[#08080A]/95 backdrop-blur-2xl p-4 shadow-[0_0_40px_rgba(0,0,0,0.6)]' : 'hidden',
        )}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/40">History</h2>
          <button type="button" onClick={() => setHistoryOpen(false)} className="text-xs text-white/20 hover:text-white/50 lg:hidden">✕</button>
        </div>
        <p className="mb-3 text-[10px] text-white/15">Last {liveData.feedDays ?? 7} days</p>
        <div className="space-y-0.5">
          <button
            type="button"
            onClick={() => { setSelectedDate(null); setHistoryData(null); setHistoryOpen(false) }}
            className={cn(
              'w-full rounded-lg px-2.5 py-2 text-left text-[11px] font-medium transition-all',
              !viewingHistory ? 'bg-[rgba(201,168,76,0.1)] text-[#E8C96A]' : 'text-white/25 hover:bg-white/[0.03] hover:text-white/40',
            )}
          >
            Today (live)
          </button>
          {(liveData.historyDates ?? []).map(date => (
            <button
              key={date}
              type="button"
              onClick={() => { void loadHistoryDay(date); setHistoryOpen(false) }}
              className={cn(
                'w-full rounded-lg px-2.5 py-2 text-left text-[11px] font-medium tabular-nums transition-all',
                selectedDate === date ? 'bg-white/[0.05] text-white/70' : 'text-white/20 hover:bg-white/[0.03] hover:text-white/35',
              )}
            >
              {date}
              {historyLoading && selectedDate === date ? ' …' : ''}
            </button>
          ))}
        </div>
      </aside>
    </div>
  )
}
