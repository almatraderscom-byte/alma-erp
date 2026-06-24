'use client'

/**
 * Plan-Drive — INLINE-IN-TURN view (owner's final redesign).
 *
 * The owner wants Plan-Drive to feel exactly like the Claude-Code transcript: when
 * he sends a message and the agent breaks it into a driven task, a single collapsed
 * HEADLINE appears inside that assistant turn — a rotating spinner + one-line
 * summary — and clicking it expands the inner step ladder (just like "Ran 2
 * commands ›" → click → details). The agent's normal reply follows underneath.
 *
 * So this is NOT a pinned dashboard: it attaches to the conversation turn. Each
 * driven plan for the current conversation renders as its own collapsible row.
 * Attention rows (needs-decision / waiting-approval) carry the owner's one-click
 * controls inside the expanded body.
 */
import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { PlanDriveView, PlanDriveStepView, PlanDriveAction } from './PlanDriveTimeline'

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

/** The exact Claude-Code rotating spinner used across the agent chat. */
function Spinner() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#E07A5F" strokeWidth="3" strokeLinecap="round" className="animate-spin" aria-hidden>
      <path d="M21 12a9 9 0 11-6.219-8.56" />
    </svg>
  )
}

function StepRow({ step, index }: { step: PlanDriveStepView; index: number }) {
  const { status } = step
  const running = status === 'running'
  const done = status === 'done'
  const failed = status === 'failed'
  return (
    <li className="flex items-start gap-2 rounded-lg px-1.5 py-1">
      <span className="mt-[1px] shrink-0">
        {running ? (
          <Spinner />
        ) : done ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
        ) : failed ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
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

function InlineDrive({ drive, onAction, onOpenConversation }: {
  drive: PlanDriveView
  onAction?: (planId: string, action: PlanDriveAction) => void | Promise<void>
  onOpenConversation?: (conversationId: string) => void
}) {
  const phase = drive.phase
  const isDecision = phase === 'needs-decision'
  const isApproval = phase === 'waiting-approval'
  const isAttention = isDecision || isApproval
  // Attention rows start OPEN (owner must see/act); driving rows start collapsed.
  const [open, setOpen] = useState(isAttention)
  const [busy, setBusy] = useState<PlanDriveAction | null>(null)
  const wake = relativeWhen(drive.nextTickAt)

  async function run(action: PlanDriveAction) {
    if (!onAction || busy) return
    setBusy(action)
    try { await onAction(drive.planId, action) } finally { setBusy(null) }
  }

  // Headline icon + tint per phase.
  const headIcon = isDecision ? '🛑' : isApproval ? '✋' : null
  const badge = isDecision ? 'সিদ্ধান্ত দরকার' : isApproval ? 'অনুমোদন দরকার' : null
  const actBtn = 'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold transition-transform active:scale-95 disabled:opacity-50'

  return (
    <div className={cn(
      'overflow-hidden rounded-xl border',
      isDecision ? 'border-red-500/25 bg-red-500/[0.05]' :
      isApproval ? 'border-amber-500/25 bg-amber-500/[0.05]' :
      'border-white/[0.07] bg-card/60',
    )}>
      {/* ── Collapsed headline (Claude-Code style: icon + summary + chevron) ── */}
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-2.5 py-2 text-left">
        <span className="shrink-0">{headIcon ? <span className="text-[13px] leading-none">{headIcon}</span> : <Spinner />}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-cream">
          <span className="text-muted font-normal">Plan-Drive · </span>{drive.goal}
        </span>
        {badge && (
          <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[8.5px] font-extrabold uppercase tracking-wide',
            isDecision ? 'bg-red-500/15 text-red-600' : 'bg-amber-500/15 text-amber-700')}>{badge}</span>
        )}
        <span className="shrink-0 text-[10px] font-semibold tabular-nums text-muted">{drive.doneCount}/{drive.totalCount}</span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={cn('shrink-0 text-muted transition-transform duration-200', open ? 'rotate-90' : '')} aria-hidden>
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>

      {/* live one-liner under the headline while collapsed & driving */}
      {!open && !isAttention && (
        <div className="px-2.5 pb-1.5 -mt-1">
          <span className="block truncate text-[11px] alma-thinking-shimmer">{drive.currentLine}</span>
        </div>
      )}

      {/* ── Expanded body: step ladder + meta + (attention) controls ── */}
      {open && (
        <div className="border-t border-white/[0.05] px-1.5 pb-2 pt-1.5">
          {drive.waitingReason && (
            <p className={cn('mb-1.5 px-1.5 text-[11px] leading-snug', isDecision ? 'text-red-600/85' : 'text-amber-700/85')}>
              {drive.waitingReason}
            </p>
          )}
          <ul className="flex flex-col">
            {drive.steps.map((s, i) => <StepRow key={s.id} step={s} index={i} />)}
          </ul>
          <div className="mt-1 flex flex-wrap items-center gap-2.5 px-1.5 text-[9.5px] text-muted">
            {wake && !isDecision && <span>🕐 পরের চেষ্টা {wake}</span>}
            {drive.costTaka > 0 && <span className="tabular-nums">৳{drive.costTaka}</span>}
            {drive.attemptCount > 0 && <span>চেষ্টা {drive.attemptCount}/{drive.maxAttempts}</span>}
          </div>

          {isAttention && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1.5">
              {drive.conversationId && onOpenConversation && (
                <button type="button" onClick={() => onOpenConversation(drive.conversationId!)}
                  className={cn('inline-flex items-center gap-1 rounded-full px-3 py-1 text-[10px] font-bold text-white shadow-sm transition-transform active:scale-95',
                    isDecision ? 'bg-red-500 hover:bg-red-600' : 'bg-amber-500 hover:bg-amber-600')}>
                  পুরো কাজ দেখুন →
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
          )}
        </div>
      )}
    </div>
  )
}

export function PlanDriveInlineTurn({ drives, onAction, onOpenConversation, className }: {
  drives: PlanDriveView[] | null | undefined
  onAction?: (planId: string, action: PlanDriveAction) => void | Promise<void>
  onOpenConversation?: (conversationId: string) => void
  className?: string
}) {
  if (!drives || drives.length === 0) return null
  return (
    <div className={cn('mb-3 flex flex-col gap-1.5', className)}>
      {drives.map((d) => (
        <InlineDrive key={d.planId} drive={d} onAction={onAction} onOpenConversation={onOpenConversation} />
      ))}
    </div>
  )
}

export default PlanDriveInlineTurn
