'use client'

/**
 * Plan-Drive — IN-CHAT view (Phase C, owner-requested redesign).
 *
 * The owner rejected the standalone "Live Desk" dashboard: he wants Plan-Drive to
 * look and live exactly like the Claude-Code "কাজের ধাপ" worklist that already
 * appears inside the chat — a compact checklist with a spinner on the running step,
 * green ticks for done, and a one-line stuck-reason + retry-time when parked. This
 * is that list, fed by the autonomous Plan-Driver instead of the agent's own daily
 * todos.
 *
 * It is the SEPARATE second todolist (the daily office dock stays as-is): only
 * tasks the agent got STUCK on are promoted here, and the owner watches the engine
 * pursue them to completion. Attention rows (needs-decision / waiting-approval) pin
 * to the top with one-click owner controls, because the owner asked for Plan-Drive
 * follow-ups to always reach him first.
 *
 * Presentational only — data + handlers come from the parent (AgentApp owns the
 * poll + the action POST), so there's a single source of truth and one poller.
 */
import { useState } from 'react'
import { cn } from '@/lib/utils'
import type {
  PlanDrivePanelData,
  PlanDriveView,
  PlanDriveStepView,
  PlanDriveAction,
} from './PlanDriveTimeline'

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

/* ── A single step row — exactly the InlineAgentTodos visual language ───────── */
function StepRow({ step, index }: { step: PlanDriveStepView; index: number }) {
  const { status } = step
  const running = status === 'running'
  const done = status === 'done'
  const failed = status === 'failed'
  return (
    <li className="flex items-start gap-2 rounded-lg px-1.5 py-1">
      <span className="mt-[1px] shrink-0">
        {running ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#E07A5F" strokeWidth="3" strokeLinecap="round" className="animate-spin"><path d="M21 12a9 9 0 11-6.219-8.56" /></svg>
        ) : done ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
        ) : failed ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        ) : status === 'skipped' ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted opacity-40"><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted opacity-50"><circle cx="12" cy="12" r="9" /></svg>
        )}
      </span>
      <span className={cn(
        'text-[12.5px] leading-snug break-words [overflow-wrap:anywhere]',
        done ? 'text-muted line-through' : failed ? 'text-red-500/80' : running ? 'alma-thinking-shimmer font-medium' : 'text-cream',
      )}>
        {index + 1}. {step.action}
      </span>
    </li>
  )
}

/* ── One driving plan — header line + compact step checklist + retry meta ───── */
function DrivingPlan({ drive }: { drive: PlanDriveView }) {
  const [open, setOpen] = useState(false)
  const wake = relativeWhen(drive.nextTickAt)
  const running = drive.steps.find((s) => s.status === 'running')
  return (
    <li className="overflow-hidden rounded-xl border border-white/[0.06] bg-card/60">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-2 px-2.5 py-2 text-left">
        <span className="mt-[2px] shrink-0">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#E07A5F" strokeWidth="3" strokeLinecap="round" className="animate-spin"><path d="M21 12a9 9 0 11-6.219-8.56" /></svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-semibold text-cream">{drive.goal}</span>
          <span className={cn('mt-0.5 block truncate text-[11px]', running ? 'alma-thinking-shimmer' : 'text-muted')}>
            {drive.currentLine}
          </span>
        </span>
        <span className="mt-[2px] shrink-0 text-[10px] font-semibold tabular-nums text-muted">{drive.doneCount}/{drive.totalCount}</span>
      </button>

      {(wake || drive.costTaka > 0 || drive.attemptCount > 0) && (
        <div className="flex items-center gap-2.5 px-2.5 pb-1.5 text-[9.5px] text-muted">
          {wake && <span>🕐 পরবর্তী চেষ্টা {wake}</span>}
          {drive.costTaka > 0 && <span className="tabular-nums">৳{drive.costTaka}</span>}
          {drive.attemptCount > 0 && <span>চেষ্টা {drive.attemptCount}/{drive.maxAttempts}</span>}
          <span className="ml-auto text-[#E07A5F]/70">{open ? 'গুটান' : 'ধাপ দেখুন'}</span>
        </div>
      )}

      {open && (
        <ul className="flex flex-col border-t border-white/[0.05] px-1.5 py-1.5">
          {drive.steps.map((s, i) => <StepRow key={s.id} step={s} index={i} />)}
        </ul>
      )}
    </li>
  )
}

/* ── An attention row — owner action first, but still compact/in-chat ───────── */
function AttentionRow({ drive, onOpenConversation, onAction }: {
  drive: PlanDriveView
  onOpenConversation?: (conversationId: string) => void
  onAction?: (planId: string, action: PlanDriveAction) => void | Promise<void>
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

  const actBtn = 'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold transition-transform active:scale-95 disabled:opacity-50'
  return (
    <li className={cn(
      'relative overflow-hidden rounded-xl border pl-2.5 pr-2 py-2',
      isDecision ? 'border-red-500/25 bg-red-500/[0.06]' : 'border-amber-500/25 bg-amber-500/[0.06]',
    )}>
      <span className={cn('absolute inset-y-0 left-0 w-[3px]', isDecision ? 'bg-red-500' : 'bg-amber-500')} aria-hidden />
      <div className="flex items-start gap-2">
        <span className="mt-[1px] shrink-0 text-[13px] leading-none">{isDecision ? '🛑' : '✋'}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={cn('rounded-full px-1.5 py-0.5 text-[8.5px] font-extrabold uppercase tracking-wide',
              isDecision ? 'bg-red-500/15 text-red-600' : 'bg-amber-500/15 text-amber-700')}>
              {isDecision ? 'সিদ্ধান্ত দরকার' : 'অনুমোদন দরকার'}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-cream">{drive.goal}</span>
          </div>
          {drive.waitingReason && (
            <p className={cn('mt-0.5 text-[10.5px] leading-snug', isDecision ? 'text-red-600/80' : 'text-amber-700/80')}>
              {drive.waitingReason}
            </p>
          )}
          <div className="mt-1 flex items-center gap-2 text-[9px] text-muted">
            <span className="tabular-nums">{drive.doneCount}/{drive.totalCount} ধাপ</span>
            {drive.costTaka > 0 && <span className="tabular-nums">· ৳{drive.costTaka}</span>}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {drive.conversationId && onOpenConversation && (
              <button type="button" onClick={() => onOpenConversation(drive.conversationId!)}
                className={cn('inline-flex items-center gap-1 rounded-full px-3 py-1 text-[10px] font-bold text-white shadow-sm transition-transform active:scale-95',
                  isDecision ? 'bg-red-500 hover:bg-red-600' : 'bg-amber-500 hover:bg-amber-600')}>
                দেখে সিদ্ধান্ত দিন →
              </button>
            )}
            {isDecision && onAction && (
              <>
                <button type="button" disabled={busy !== null} onClick={() => run('resume')}
                  className={cn(actBtn, 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20')}>
                  {busy === 'resume' ? '⏳' : '▶'} আবার চালাও
                </button>
                <button type="button" disabled={busy !== null} onClick={() => run('add-budget')}
                  className={cn(actBtn, 'border border-[#E07A5F]/40 bg-[#E07A5F]/10 text-[#C45A3C] hover:bg-[#E07A5F]/20')}>
                  {busy === 'add-budget' ? '⏳' : '৳'} বাজেট বাড়াও
                </button>
                <button type="button" disabled={busy !== null} onClick={() => run('abandon')}
                  className={cn(actBtn, 'border border-border-subtle text-muted hover:bg-white/[0.04]')}>
                  {busy === 'abandon' ? '⏳' : '✕'} বাদ দাও
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </li>
  )
}

export function PlanDriveInChat({ data, onOpenConversation, onAction, className }: {
  data: PlanDrivePanelData | null | undefined
  onOpenConversation?: (conversationId: string) => void
  onAction?: (planId: string, action: PlanDriveAction) => void | Promise<void>
  className?: string
}) {
  const drives = data?.drives ?? []
  if (drives.length === 0) return null

  const attention = drives.filter((d) => d.phase === 'needs-decision' || d.phase === 'waiting-approval')
  const working = drives.filter((d) => d.phase === 'driving')
  const total = drives.length
  const doneSteps = drives.reduce((n, d) => n + d.doneCount, 0)
  const allSteps = drives.reduce((n, d) => n + d.totalCount, 0)

  return (
    <div className={cn('mb-3 overflow-hidden rounded-2xl border border-white/[0.07] bg-card/70 backdrop-blur-sm', className)}>
      {/* header — same shape as InlineAgentTodos' "কাজের ধাপ" bar */}
      <div className="flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold text-muted">
        <span className="relative flex h-2 w-2">
          <span className={cn('absolute inline-flex h-full w-full rounded-full opacity-75', working.length > 0 ? 'animate-ping bg-[#E07A5F]' : 'bg-zinc-400/60')} />
          <span className={cn('relative inline-flex h-2 w-2 rounded-full', working.length > 0 ? 'bg-[#E07A5F]' : 'bg-zinc-400')} />
        </span>
        <span>Plan-Drive · ফলো-আপ</span>
        {attention.length > 0 && (
          <span className="rounded-full bg-red-500/12 px-1.5 py-0.5 text-[9px] font-bold text-red-600">{attention.length} অপেক্ষায়</span>
        )}
        <span className="ml-auto font-normal tabular-nums text-muted">{doneSteps}/{allSteps || total}</span>
      </div>

      <div className="flex flex-col gap-1.5 px-2 pb-2">
        {attention.map((d) => (
          <AttentionRow key={d.planId} drive={d} onOpenConversation={onOpenConversation} onAction={onAction} />
        ))}
        {working.map((d) => (
          <DrivingPlan key={d.planId} drive={d} />
        ))}
      </div>
    </div>
  )
}

export default PlanDriveInChat
