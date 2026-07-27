'use client'

/**
 * Plan-Drive "Live Desk" (Phase C) — its OWN visual language, not a copy of the
 * office-shift timeline. The owner watches the agent pursue each autonomous plan
 * the way you watch Claude Code work: a vertical step ladder where the current step
 * shimmers "live", finished steps tick green, and the whole thing reads like a real
 * person working through a task in front of you.
 *
 * Two zones, by urgency:
 *   1. ⚠️ ATTENTION — a loud stack of everything waiting on YOU (decisions first,
 *      then approvals). One glance tells you what is blocked on your nod.
 *   2. ▶ WORKING   — plans the agent is actively driving, each a live step ladder
 *      with a self-scheduled next wake-up.
 */
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'

type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
type Phase = 'driving' | 'waiting-approval' | 'needs-decision' | 'done'

export interface PlanDriveStepView {
  id: string
  action: string
  status: StepStatus
  toolName?: string
  detail?: string
}

export interface PlanDriveView {
  planId: string
  goal: string
  conversationId: string | null
  phase: Phase
  steps: PlanDriveStepView[]
  doneCount: number
  totalCount: number
  currentLine: string
  waitingReason?: string
  nextTickAt: string | null
  lastDrivenAt: string | null
  attemptCount: number
  maxAttempts: number
  costTaka: number
  /** G1 — honest state, straight from the server. Never inferred here. */
  isRunning?: boolean
  statusLabel?: string
  runningStep?: string | null
  idleMs?: number | null
  /** Agent-started work — belongs to no owner chat, so show it in any chat. */
  isAutonomous?: boolean
  /** Present only for a "fix everything" campaign — every number here is measured. */
  grind?: GrindDriveView
}

export interface GrindDriveView {
  campaignId: string
  target: string
  headline: string
  total: number
  fixed: number
  open: number
  claimedOnly: number
  regressed: number
  introduced: number
  blockers: string[]
  families: Array<{ family: string; total: number; fixed: number; open: number; mode: 'proposal' | 'apply' }>
}

export interface LiveJobView {
  actionId: string
  type: string
  summary: string
  startedAt: string
  runningMs: number
  conversationId: string | null
}

export interface PlanDrivePanelData {
  enabled: boolean
  drives: PlanDriveView[]
  runningCount?: number
  waitingApprovalCount?: number
  /** G4 — worker jobs running right now (crawl/audit/long task). */
  runningJobs?: LiveJobView[]
  activeCount: number
  needsDecisionCount: number
  dailyCapTaka: number
  perPlanCapTaka: number
}

export type PlanDriveAction = 'resume' | 'add-budget' | 'abandon' | 'family-auto' | 'family-stop'

/** "২ মিনিট ধরে" — how long a worker job has been running. */
function runningFor(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'এইমাত্র শুরু'
  if (min < 60) return `${min} মিনিট ধরে`
  return `${Math.round(min / 60)} ঘণ্টা ধরে`
}

/** "৪২ মিনিট" / "১ ঘণ্টা" — how long this plan has been silent. */
function idleFor(ms: number | null | undefined): string {
  if (!ms || ms < 5 * 60_000) return ''
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min} মিনিট`
  const h = Math.round(min / 60)
  return h < 24 ? `${h} ঘণ্টা` : `${Math.round(h / 24)} দিন`
}

function relativeWhen(iso: string | null): string {
  if (!iso) return ''
  const diffMin = Math.round((new Date(iso).getTime() - Date.now()) / 60000)
  if (Number.isNaN(diffMin)) return ''
  if (diffMin <= 0) return 'এখনই'
  if (diffMin < 60) return `${diffMin} মিনিট পরে`
  const h = Math.round(diffMin / 60)
  if (h < 24) return `${h} ঘণ্টা পরে`
  return `${Math.round(h / 24)} দিন পরে`
}

/* ── Step node — the heart of the "agent working" feel ─────────────────────── */
function StepNode({ status }: { status: StepStatus }) {
  if (status === 'done') {
    return (
      <span className="relative z-10 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white shadow-[0_0_8px_rgba(16,185,129,0.45)]">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
      </span>
    )
  }
  if (status === 'running') {
    return (
      <span className="relative z-10 flex h-5 w-5 items-center justify-center">
        <span className="absolute inset-0 rounded-full bg-[#E07A5F]/30 animate-ping" />
        <span className="relative h-3 w-3 rounded-full bg-[#E07A5F] shadow-[0_0_10px_rgba(224,122,95,0.7)]" />
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="relative z-10 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white shadow-[0_0_8px_rgba(239,68,68,0.45)]">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </span>
    )
  }
  if (status === 'skipped') {
    return <span className="relative z-10 flex h-5 w-5 items-center justify-center rounded-full border border-border-subtle bg-card text-[8px] text-muted">–</span>
  }
  // pending
  return <span className="relative z-10 flex h-5 w-5 items-center justify-center rounded-full border-2 border-border-subtle bg-card" />
}

/* ── A live working plan — vertical step ladder ───────────────────────────── */
function WorkingPlan({ drive, onOpen, onAction }: {
  drive: PlanDriveView
  onOpen?: (id: string) => void
  onAction?: (planId: string, action: PlanDriveAction, family?: string) => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const wake = relativeWhen(drive.nextTickAt)
  const pct = drive.totalCount > 0 ? Math.round((drive.doneCount / drive.totalCount) * 100) : 0
  const runningStep = drive.steps.find((s) => s.status === 'running')
  // G1 — trust the server's honest flag; only fall back to inference for an old
  // payload that predates it.
  const live = drive.isRunning ?? (Boolean(runningStep) || Boolean(drive.nextTickAt))
  const idle = idleFor(drive.idleMs)

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="overflow-hidden rounded-2xl border border-border-subtle bg-card/70"
    >
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-3 px-3.5 py-3 text-left">
        {/* G1: the dot pulses ONLY while the plan is genuinely moving. A parked
            plan gets a still, amber dot — never the "it's working" animation. */}
        <span className={cn(
          'relative mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl',
          live ? 'bg-[#E07A5F]/10' : 'bg-amber-500/10',
        )}>
          <span className={cn('absolute inset-0 rounded-xl border', live ? 'border-[#E07A5F]/30' : 'border-amber-500/30')} />
          <span className={cn(
            'h-2 w-2 rounded-full',
            live
              ? 'bg-[#E07A5F] shadow-[0_0_8px_rgba(224,122,95,0.7)] animate-pulse'
              : 'bg-amber-500',
          )} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-semibold text-cream/90">{drive.goal}</span>
          <span className={cn('mt-0.5 block truncate text-[10.5px]', live && runningStep ? 'alma-thinking-shimmer' : 'text-muted')}>
            {drive.currentLine}
          </span>
          {/* progress rail */}
          <span className="mt-2 flex items-center gap-2">
            <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-border-subtle">
              <motion.span
                layout
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#F4A28C] to-[#E07A5F]"
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="shrink-0 text-[9px] font-semibold tabular-nums text-muted">{drive.doneCount}/{drive.totalCount}</span>
          </span>
        </span>
      </button>

      {/* meta strip */}
      <div className="flex items-center gap-3 px-3.5 pb-2.5 text-[9px] text-muted">
        {/* Honest state first — "চলছে" only when it really is. */}
        <span className={cn('font-semibold', live ? 'text-[#E07A5F]' : 'txt-warn')}>
          {drive.statusLabel ?? (live ? 'চলছে' : 'অপেক্ষায়')}
        </span>
        {!live && idle && <span>{idle} ধরে থেমে</span>}
        {wake && <span className="inline-flex items-center gap-1">🕐 পরবর্তী {wake}</span>}
        {drive.costTaka > 0 && <span className="tabular-nums">৳{drive.costTaka}</span>}
        {drive.attemptCount > 0 && <span>চেষ্টা {drive.attemptCount}/{drive.maxAttempts}</span>}
        <span className="ml-auto text-[#E07A5F]/80">{open ? 'গুটিয়ে নিন' : 'ধাপগুলো দেখুন'}</span>
      </div>

      {/* campaign progress — measured counts, never claims */}
      {drive.grind && <GrindBlock grind={drive.grind} planId={drive.planId} onAction={onAction} />}

      {/* step ladder */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
            <div className="relative px-4 pb-3.5 pt-1">
              {/* the connecting spine */}
              <span className="absolute bottom-6 left-[26px] top-2 w-px bg-border-subtle" aria-hidden />
              <div className="space-y-2.5">
                {drive.steps.map((s, i) => (
                  <div key={s.id} className="relative flex items-start gap-3">
                    <StepNode status={s.status} />
                    <div className="min-w-0 flex-1 pt-0.5">
                      <p className={cn(
                        'text-[11px] leading-snug',
                        s.status === 'done' ? 'text-cream/55 line-through decoration-emerald-500/40' :
                        s.status === 'running' ? 'alma-thinking-shimmer font-medium' :
                        s.status === 'failed' ? 'txt-neg' :
                        'text-cream/75',
                      )}>
                        {i + 1}. {s.action}
                      </p>
                      {s.detail && <p className="mt-0.5 truncate text-[9.5px] text-muted">{s.detail}</p>}
                    </div>
                  </div>
                ))}
              </div>
              {drive.conversationId && onOpen && (
                <button
                  type="button"
                  onClick={() => onOpen(drive.conversationId!)}
                  className="mt-3 ml-[34px] inline-flex items-center gap-1.5 rounded-full border border-[#E07A5F]/30 bg-[#E07A5F]/[0.08] px-3 py-1.5 text-[10px] font-bold text-[#E07A5F] transition-colors hover:bg-[#E07A5F]/15"
                >
                  পুরো কাজ লাইভ দেখুন →
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/* ── Campaign progress — measured counts, and the two family buttons ──────── */
function GrindBlock({ grind, planId, onAction }: {
  grind: GrindDriveView
  planId: string
  onAction?: (planId: string, action: PlanDriveAction, family?: string) => void | Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)

  async function run(action: PlanDriveAction, family: string) {
    if (!onAction || busy) return
    setBusy(`${action}:${family}`)
    try {
      await onAction(planId, action, family)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-3.5 mb-2.5 rounded-xl border border-border-subtle bg-card/60 px-3 py-2.5">
      <p className="text-[10.5px] font-semibold text-cream/85">{grind.headline}</p>
      {grind.regressed > 0 && (
        <p className="mt-1 text-[9.5px] font-semibold txt-neg">
          ⚠️ {grind.regressed} টা আবার ভেঙেছে — ঠিক করতে গিয়ে নতুন সমস্যা হয়েছে
        </p>
      )}
      {grind.blockers.length > 0 && (
        <p className="mt-1 text-[9.5px] text-muted">বাকি: {grind.blockers.join(' · ')}</p>
      )}

      <div className="mt-2 space-y-1.5">
        {grind.families.slice(0, 8).map((f) => {
          const pct = f.total > 0 ? Math.round((f.fixed / f.total) * 100) : 0
          return (
            <div key={f.family} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[9.5px] text-cream/70">{f.family}</span>
              <span className="relative h-1 w-16 overflow-hidden rounded-full bg-border-subtle">
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-emerald-500/80"
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="w-10 shrink-0 text-right text-[9px] tabular-nums text-muted">{f.fixed}/{f.total}</span>
              {onAction && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => run(f.mode === 'apply' ? 'family-stop' : 'family-auto', f.family)}
                  className="shrink-0 rounded-full border border-[#E07A5F]/30 px-2 py-0.5 text-[8.5px] font-bold text-[#E07A5F] disabled:opacity-50"
                >
                  {f.mode === 'apply' ? 'থামাও' : 'আর জিজ্ঞেস কোরো না'}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ── An attention card — loud, owner-action-first ─────────────────────────── */
function AttentionCard({ drive, onOpen, onAction }: {
  drive: PlanDriveView
  onOpen?: (id: string) => void
  onAction?: (planId: string, action: PlanDriveAction, family?: string) => void | Promise<void>
}) {
  const isDecision = drive.phase === 'needs-decision'
  const [busy, setBusy] = useState<PlanDriveAction | null>(null)

  async function run(action: PlanDriveAction) {
    if (!onAction || busy) return
    setBusy(action)
    try {
      await onAction(drive.planId, action)
    } finally {
      setBusy(null)
    }
  }

  const actBtn = 'inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[10px] font-bold transition-transform active:scale-95 disabled:opacity-50'
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      className={cn(
        'relative overflow-hidden rounded-2xl border pl-3.5 pr-3 py-3',
        isDecision ? 'border-red-500/30 bg-red-50/70' : 'border-amber-500/30 bg-amber-50/60',
      )}
    >
      {/* left urgency bar */}
      <span className={cn('absolute inset-y-0 left-0 w-1', isDecision ? 'bg-red-500' : 'bg-amber-500')} aria-hidden />
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-base leading-none">{isDecision ? '🛑' : '✋'}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn('rounded-full px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wide',
              isDecision ? 'bg-red-500/15 txt-neg' : 'bg-amber-500/15 txt-warn')}>
              {isDecision ? 'সিদ্ধান্ত দরকার' : 'অনুমোদন দরকার'}
            </span>
            <span className="truncate text-[12px] font-bold text-cream/90">{drive.goal}</span>
          </div>
          {drive.waitingReason && (
            <p className={cn('mt-1 text-[10.5px] leading-snug', isDecision ? 'txt-neg' : 'txt-warn')}>
              {drive.waitingReason}
            </p>
          )}
          <div className="mt-1.5 flex items-center gap-2 text-[9px] text-muted">
            <span className="tabular-nums">{drive.doneCount}/{drive.totalCount} ধাপ শেষ</span>
            {drive.costTaka > 0 && <span className="tabular-nums">· ৳{drive.costTaka} খরচ</span>}
          </div>

          {/* Owner controls — open the live trail, then the one-click decisions. */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {drive.conversationId && onOpen && (
              <button
                type="button"
                onClick={() => onOpen(drive.conversationId!)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[10.5px] font-bold text-white shadow-sm transition-transform active:scale-95',
                  isDecision ? 'bg-red-500 hover:bg-red-600' : 'bg-amber-500 hover:bg-amber-600',
                )}
              >
                দেখে সিদ্ধান্ত দিন →
              </button>
            )}
            {isDecision && onAction && (
              <>
                <button type="button" disabled={busy !== null} onClick={() => run('resume')}
                  className={cn(actBtn, 'border border-emerald-500/40 bg-emerald-500/10 txt-pos hover:bg-emerald-500/20')}>
                  {busy === 'resume' ? '⏳' : '▶'} আবার চালাও
                </button>
                <button type="button" disabled={busy !== null} onClick={() => run('add-budget')}
                  className={cn(actBtn, 'border border-[#E07A5F]/40 bg-[#E07A5F]/10 text-[#C45A3C] hover:bg-[#E07A5F]/20')}>
                  {busy === 'add-budget' ? '⏳' : '৳'} বাজেট বাড়াও
                </button>
                <button type="button" disabled={busy !== null} onClick={() => run('abandon')}
                  className={cn(actBtn, 'border border-zinc-300 text-muted hover:bg-zinc-100')}>
                  {busy === 'abandon' ? '⏳' : '✕'} বাদ দাও
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  )
}

export function PlanDriveTimeline({ data, onOpenConversation, onAction }: {
  data: PlanDrivePanelData
  onOpenConversation?: (conversationId: string) => void
  onAction?: (planId: string, action: PlanDriveAction, family?: string) => void | Promise<void>
}) {
  const drives = data?.drives ?? []
  // G4 — a running worker job is reason enough to show the desk, even with no
  // plan in flight. Otherwise a live crawl stays invisible.
  if (drives.length === 0 && (data?.runningJobs?.length ?? 0) === 0) return null

  const attention = drives.filter((d) => d.phase === 'needs-decision' || d.phase === 'waiting-approval')
  // G1 — "N চলছে" counts plans that are genuinely moving, not every non-parked
  // row. His phone said "Running 2" about two plans that had been dead an hour.
  const working = drives.filter((d) => d.phase === 'driving')
  const runningNow = drives.filter((d) => d.isRunning ?? d.phase === 'driving')

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="overflow-hidden rounded-3xl border border-[#E07A5F]/20 bg-gradient-to-b from-card/90 to-card/60 shadow-[0_2px_24px_rgba(224,122,95,0.06)]"
    >
      {/* G4 — queued worker work, visible AS work. An 8-minute crawl used to look
          like the agent had gone quiet; now it says what is running and for how
          long, every poll. */}
      {(data.runningJobs?.length ?? 0) > 0 && (
        <div className="border-b border-border-subtle bg-emerald-500/[0.05] px-4 py-2.5">
          {data.runningJobs!.map((job) => (
            <div key={job.actionId} className="flex items-center gap-2 py-0.5">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-cream/85">{job.summary}</span>
              <span className="shrink-0 text-[9.5px] tabular-nums text-muted">{runningFor(job.runningMs)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Live-desk header */}
      <div className="flex items-center gap-2.5 border-b border-border-subtle px-4 py-3">
        <span className="relative flex h-2.5 w-2.5">
          <span className={cn('absolute inline-flex h-full w-full rounded-full opacity-75', runningNow.length > 0 ? 'animate-ping bg-emerald-400' : 'bg-zinc-300')} />
          <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', runningNow.length > 0 ? 'bg-emerald-500' : 'bg-zinc-400')} />
        </span>
        <h3 className="text-[13px] font-extrabold tracking-tight text-cream/90">এজেন্ট লাইভ ডেস্ক</h3>
        <span className="text-[10px] text-muted">Plan-Drive</span>
        <div className="ml-auto flex items-center gap-1.5">
          {attention.length > 0 && (
            <span className="rounded-full bg-red-500/12 px-2 py-0.5 text-[9px] font-bold txt-neg">
              {attention.length} অপেক্ষায়
            </span>
          )}
          {runningNow.length > 0 && (
            <span className="rounded-full bg-emerald-500/12 px-2 py-0.5 text-[9px] font-bold txt-pos">
              {runningNow.length} চলছে
            </span>
          )}
          {working.length > runningNow.length && (
            <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[9px] font-bold txt-warn">
              {working.length - runningNow.length} থেমে আছে
            </span>
          )}
          {!data.enabled && (
            <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[9px] font-bold uppercase text-muted">বন্ধ</span>
          )}
        </div>
      </div>

      <div className="space-y-4 p-3.5">
        {/* ⚠️ Attention zone */}
        {attention.length > 0 && (
          <div className="space-y-2">
            <p className="px-1 text-[9.5px] font-bold uppercase tracking-[0.1em] txt-neg">⚠ আপনার নজর দরকার</p>
            <AnimatePresence initial={false}>
              {attention.map((d) => (
                <AttentionCard key={d.planId} drive={d} onOpen={onOpenConversation} onAction={onAction} />
              ))}
            </AnimatePresence>
          </div>
        )}

        {/* ▶ Working zone */}
        {working.length > 0 && (
          <div className="space-y-2">
            <p className="px-1 text-[9.5px] font-bold uppercase tracking-[0.1em] txt-pos">▶ এখন কাজ করছে</p>
            <AnimatePresence initial={false}>
              {working.map((d) => (
                <WorkingPlan key={d.planId} drive={d} onOpen={onOpenConversation} onAction={onAction} />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </motion.div>
  )
}
