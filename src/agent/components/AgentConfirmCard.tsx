'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import AgentSparkleLoader from './AgentSparkleLoader'
import AgentWorkingDots from './AgentWorkingDots'
import { notifyTodosChanged } from './AgentTodoContext'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import { notifyError, notifySuccess, notifyWarning } from '@/lib/haptics'
import { approvalSuccess, showPulseSuccess } from '@/lib/live-pulse'

export interface PendingAction {
  id: string
  summary: string
  costEstimate?: number
  actionType?: string
  entryCount?: number
  isFinance?: boolean
  isBatch?: boolean
  /**
   * Only set for cards rebuilt from history on page reload. Carries the current
   * pending-action status ('approved' | 'executed' | 'rejected' | 'expired' |
   * 'failed' | 'pending'). A resolved value renders a static record breadcrumb
   * instead of a fresh actionable card; 'pending'/undefined → normal interactive
   * card. Live cards from the SSE stream never set this.
   */
  resolvedStatus?: string
  /** Why a 'failed' action failed — owner rule: failures are never silent. */
  failReason?: string
}

/** Settled-record presentation for a confirm card rebuilt from history. */
const RESOLVED_RECORD: Record<string, { icon: string; label: string; tone: string; text: string }> = {
  approved: { icon: '✅', label: 'অনুমোদিত', tone: 'border tone-green', text: 'আপনি অনুমোদন করেছিলেন' },
  executed: { icon: '✅', label: 'অনুমোদিত ও সম্পন্ন', tone: 'border tone-green', text: 'আপনি অনুমোদন করেছিলেন — কাজটি সম্পন্ন হয়েছে' },
  rejected: { icon: '❌', label: 'বাতিল', tone: 'border tone-red', text: 'আপনি বাতিল করেছিলেন' },
  expired: { icon: '⏱️', label: 'সময় শেষ', tone: 'border tone-slate', text: 'সময় শেষ হয়ে গিয়েছিল — সিদ্ধান্ত নেওয়া হয়নি' },
  failed: { icon: '⚠️', label: 'ব্যর্থ', tone: 'border tone-amber', text: 'অনুমোদন করেছিলেন, কিন্তু কাজটি ব্যর্থ হয়েছে' },
}

type CardPhase = 'idle' | 'loading' | 'approved' | 'rejected' | 'editing' | 'settled' | 'opinion'

// Card types where "💬 আমার মত" edits the SAME pending card in place via the head
// (POST .../revise) instead of the legacy reject-and-restart-in-chat. Mirrors the
// server-side REVISABLE_ACTION_TYPES (src/agent/lib/revise-pending.ts). Anything
// not here keeps the old reject+onQuickSend path when a chat thread is available.
const REVISABLE_TYPES = new Set<string>([
  'dispatch_staff_tasks',
  'delegation',
  'send_customer_message',
  'staff_announcement',
  'fb_post',
  'instagram_post',
  'marketing_plan',
  'content_gate1',
  'content_gate2',
  'ad_creative_gate',
])

// Server guard responses that are NOT real failures — the card was already
// handled, timed out, or is gone. Show a calm note, not a red error toast.
const TERMINAL_NOTES: Record<string, string> = {
  already_resolved: 'এই কার্ডটি আগেই প্রসেস হয়ে গেছে ✓',
  expired: 'সময় শেষ — কার্ডটি আর সক্রিয় নেই (৩০ মিনিটের সীমা)।',
  not_found: 'কার্ডটি আর পাওয়া যাচ্ছে না — সম্ভবত আগেই প্রসেস হয়েছে।',
}

interface AgentConfirmCardProps {
  action: PendingAction
  onResolved: (status: 'approved' | 'rejected') => void
  onUpdated?: (summary: string, meta: Partial<PendingAction>) => void
  /**
   * Owner's "আমার মত" (my opinion) path: reject this pending action AND feed the
   * owner's correction straight back to the agent so it redoes the task the right
   * way — instead of a blunt approve/reject. Wired from AgentThread → handleSend.
   */
  onQuickSend?: (text: string) => void
}

const EDIT_FIELDS: Record<string, string> = {
  amount: '💰 পরিমাণ',
  personName: '👤 নাম',
  category: '📂 ক্যাটাগরি',
  direction: '↔️ দিক',
  currency: '💱 মুদ্রা',
  note: '📝 নোট',
}

export default function AgentConfirmCard({ action, onResolved, onUpdated, onQuickSend }: AgentConfirmCardProps) {
  const [phase, setPhase] = useState<CardPhase>('idle')
  const [loadingDecision, setLoadingDecision] = useState<'approve' | 'reject' | 'revise' | null>(null)
  const [summary, setSummary] = useState(action.summary)
  const [meta, setMeta] = useState(action)
  const [editField, setEditField] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editFields, setEditFields] = useState<string[]>([])
  const [terminalNote, setTerminalNote] = useState('')
  const [opinionText, setOpinionText] = useState('')
  // Owner can tap the backdrop to tuck the sheet away and keep reading the thread;
  // the pending action isn't lost — an inline pill re-opens it.
  const [minimized, setMinimized] = useState(false)

  useEffect(() => {
    if (!action.isFinance) return
    void fetch(`/api/assistant/actions/${action.id}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.editFields) setEditFields(d.editFields as string[]) })
      .catch(() => {})
  }, [action.id, action.isFinance])

  // Reloaded-from-history card whose action is already resolved → show a static
  // record so the owner can SEE that they approved/rejected and that the tool was
  // called, instead of the card silently vanishing on refresh. Live cards (from
  // the SSE stream) never set resolvedStatus, so they keep the interactive flow.
  if (action.resolvedStatus && action.resolvedStatus !== 'pending') {
    const rec = RESOLVED_RECORD[action.resolvedStatus] ?? RESOLVED_RECORD.expired
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className={`mt-3 w-full max-w-full overflow-hidden rounded-2xl border px-3.5 py-2.5 text-xs shadow-float ${rec.tone}`}
      >
        <div className="flex items-center gap-1.5 font-semibold">
          <span aria-hidden>{rec.icon}</span>
          <span>{rec.label}</span>
          <span className="ml-auto text-[10px] font-normal opacity-70">{rec.text}</span>
        </div>
        <pre className="mt-1.5 max-w-full overflow-x-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-sans text-[11px] leading-relaxed text-cream opacity-90">{action.summary}</pre>
        {action.resolvedStatus === 'failed' && action.failReason && (
          <div className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200/90 break-words [overflow-wrap:anywhere]">
            <b>কারণ:</b> {action.failReason}
          </div>
        )}
      </motion.div>
    )
  }

  async function resolve(decision: 'approve' | 'reject') {
    if (phase !== 'idle' && phase !== 'editing') return
    setPhase('loading')
    setLoadingDecision(decision)
    try {
      const res = await fetch(`/api/assistant/actions/${meta.id}/${decision}`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string }
        const code = err.error ?? ''
        // Already-handled / expired / gone → not a crash. Settle quietly so the
        // owner isn't shown a scary error for a card that's simply done.
        if (TERMINAL_NOTES[code]) {
          setTerminalNote(TERMINAL_NOTES[code])
          setPhase('settled')
          onResolved(decision === 'approve' ? 'approved' : 'rejected')
          notifyTodosChanged()
          return
        }
        throw new Error(code || `HTTP ${res.status}`)
      }
      setPhase(decision === 'approve' ? 'approved' : 'rejected')
      if (decision === 'approve') notifySuccess()
      else notifyWarning()
      // Flash the Dynamic Panel's success state — only now, after the server
      // confirmed (spec §6.6). It falls back to authoritative live state on the
      // next sync, so an outdated cache can never linger on the lock screen.
      if (decision === 'approve') void showPulseSuccess(approvalSuccess())
      toast.success(decision === 'approve' ? 'অনুমোদিত ✓' : 'বাতিল করা হয়েছে')
      onResolved(decision === 'approve' ? 'approved' : 'rejected')
      // A resolved card may have cancelled/created a todo (e.g. todo_cancel) —
      // refresh the dock immediately so it doesn't linger until the next poll.
      notifyTodosChanged()
    } catch (err) {
      notifyError()
      toast.error(`সমস্যা: ${err instanceof Error ? err.message : String(err)}`)
      setPhase('idle')
      setLoadingDecision(null)
    }
  }

  async function removeBatchItem(index: number) {
    try {
      const res = await fetch(`/api/assistant/actions/${meta.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeEntryIndex: index }),
      })
      const data = await res.json() as PendingAction & { summary: string; entryCount?: number; isBatch?: boolean }
      if (!res.ok) throw new Error(data.summary ?? 'patch failed')
      setSummary(data.summary)
      const next = { ...meta, summary: data.summary, entryCount: data.entryCount, isBatch: data.isBatch }
      setMeta(next)
      onUpdated?.(data.summary, next)
      toast.success(`#${index + 1} সরানো হয়েছে`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function applyEdit() {
    if (!editField || !editValue.trim()) return
    try {
      const res = await fetch(`/api/assistant/actions/${meta.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: editField, value: editValue.trim() }),
      })
      const data = await res.json() as { summary: string; entryCount?: number; isBatch?: boolean }
      if (!res.ok) throw new Error((data as { error?: string }).error ?? 'patch failed')
      setSummary(data.summary)
      setEditField(null)
      setEditValue('')
      setPhase('idle')
      onUpdated?.(data.summary, meta)
      toast.success('কার্ড আপডেট হয়েছে')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  // "আমার মত" — the third path. For revisable cards the head re-edits THIS pending
  // card in place (POST .../revise) and confirms, so it stays approvable — no chat
  // context reload, no token-heavy restart. Non-revisable cards fall back to the
  // legacy reject-and-hand-to-chat path (only when a chat thread is available).
  async function submitOpinion() {
    const note = opinionText.trim()
    if (!note) return

    if (!REVISABLE_TYPES.has(meta.actionType ?? '')) {
      // Legacy fallback: reject + re-ask in chat (needs onQuickSend).
      setPhase('loading')
      setLoadingDecision('reject')
      try {
        await fetch(`/api/assistant/actions/${meta.id}/reject`, { method: 'POST' }).catch(() => {})
        onResolved('rejected')
        notifyTodosChanged()
        onQuickSend?.(note)
        setPhase('settled')
        setTerminalNote('আপনার মত এজেন্টকে পাঠানো হয়েছে — সে ঠিক করে দিচ্ছে')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
        setPhase('idle')
        setLoadingDecision(null)
      }
      return
    }

    setPhase('loading')
    setLoadingDecision('revise')
    try {
      const res = await fetch(`/api/assistant/actions/${meta.id}/revise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: note }),
      })
      const data = await res.json().catch(() => ({})) as {
        error?: string; message?: string; reply?: string
        action?: { id?: string; summary?: string; status?: string } | null
      }
      if (!res.ok) {
        const code = data.error ?? ''
        if (TERMINAL_NOTES[code]) {
          setTerminalNote(TERMINAL_NOTES[code])
          setPhase('settled')
          onResolved('rejected')
          notifyTodosChanged()
          return
        }
        throw new Error(data.message || code || `HTTP ${res.status}`)
      }
      const reply = data.reply?.trim() || 'ঠিক আছে — কার্ডটা আপডেট করেছি।'
      const after = data.action ?? null
      setOpinionText('')
      if (after?.status === 'pending' && after.summary) {
        // Edited in place → show the revised card, still Approve/Reject-able.
        setSummary(after.summary)
        const next = { ...meta, id: after.id ?? meta.id, summary: after.summary }
        setMeta(next)
        onUpdated?.(after.summary, next)
        setPhase('idle')
        notifySuccess()
        toast.success(reply)
      } else {
        // Superseded / executed — settle with the head's confirmation.
        setTerminalNote(reply)
        setPhase('settled')
        onResolved('rejected')
        notifyTodosChanged()
      }
    } catch (err) {
      notifyError()
      toast.error(`সমস্যা: ${err instanceof Error ? err.message : String(err)}`)
      setPhase('idle')
      setLoadingDecision(null)
    }
  }

  // iPhone fix: NO framer `layout` prop on these cards. `layout` re-measures the
  // element on every surrounding change (streaming text growing above it, the
  // auto-scroll) and animates the delta with a transform — on the width-locked
  // WKWebView that read as the whole card briefly zooming/scaling and its right
  // edge (the "Sonnet বলুক" button) getting clipped. Plain enter animation only.
  const isDelegation = meta.actionType === 'delegation'

  const loadingLabel =
    loadingDecision === 'approve'
      ? (isDelegation ? 'Worker কাজ শুরু করছে…' : 'অনুমোদন প্রক্রিয়া হচ্ছে…')
      : loadingDecision === 'revise'
        ? 'এজেন্ট আপনার মত অনুযায়ী কার্ডটা ঠিক করছে…'
        : loadingDecision === 'reject'
          ? (isDelegation ? 'Sonnet নিজে উত্তর দিচ্ছে…' : 'বাতিল করা হচ্ছে…')
          : 'প্রক্রিয়া হচ্ছে…'

  // iPhone fix (issue #3): the big amber delegation card kept clipping/zooming on
  // the width-locked WKWebView. Owner asked for a small Claude-style chip instead.
  // Compact variant: narrow, no min-width buttons, single short line — structurally
  // cannot overflow. Covers every phase so the big card never renders for delegation.
  if (isDelegation) {
    if (phase === 'loading') {
      return (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: 'easeOut' }}
          className="mt-3 flex items-center gap-2.5 rounded-2xl border border-border-subtle bg-card/70 px-3.5 py-2.5 shadow-float backdrop-blur-sm">
          <AgentWorkingDots />
          <span className="text-xs font-medium text-cream/90">{loadingLabel}</span>
        </motion.div>
      )
    }
    if (phase === 'approved' || phase === 'rejected' || phase === 'settled') {
      const isApproved = phase === 'approved'
      const isRejected = phase === 'rejected'
      const ongoing = isApproved || isRejected // work is now happening → live dots
      const note = isApproved
        ? 'Worker কাজটি করছে — উত্তর নিচে আসবে'
        : isRejected
          ? 'Sonnet নিজে উত্তর দিচ্ছে — নিচে আসবে'
          : terminalNote
      const tone = isApproved
        ? 'border-[#81B29A]/30 bg-[#81B29A]/[0.08]'
        : isRejected
          ? 'border-[#E07A5F]/30 bg-[#E07A5F]/[0.08]'
          : 'border-border-subtle bg-card/70'
      return (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: 'easeOut' }}
          className={`mt-3 flex items-center gap-2.5 rounded-2xl border px-3.5 py-2.5 shadow-float ${tone}`}>
          <span className="shrink-0 text-base leading-none">{isApproved ? '🤝' : isRejected ? '🧠' : 'ℹ️'}</span>
          <span className="min-w-0 flex-1 text-xs font-medium text-cream/90">{note}</span>
          {ongoing && <AgentWorkingDots className="shrink-0" />}
        </motion.div>
      )
    }
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: 'easeOut' }}
        className="mt-3 w-full max-w-full overflow-hidden rounded-2xl border tone-amber px-3 py-2.5 text-xs shadow-float">
        <div className="mb-1.5 flex items-center gap-1.5 font-semibold">
          <span>🤝</span><span>কে করবে?</span>
        </div>
        <p className="mb-2.5 break-words [overflow-wrap:anywhere] leading-relaxed text-cream">{summary}</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => resolve('approve')}
            className="min-w-0 flex-1 rounded-lg border tone-green px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:bg-green-500/20">
            Worker
          </button>
          <button type="button" onClick={() => resolve('reject')}
            className="min-w-0 flex-1 rounded-lg border tone-purple px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:bg-purple-500/20">
            Sonnet
          </button>
        </div>
      </motion.div>
    )
  }

  if (phase === 'loading') {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: 'easeOut' }}
        className="mt-3 flex min-h-[140px] items-center justify-center rounded-[18px] border tone-amber p-6 shadow-float">
        <AgentSparkleLoader label={loadingLabel} size="lg" />
      </motion.div>
    )
  }

  if (phase === 'approved') {
    // image_gen / video_gen are async: after approval the VPS worker keeps working
    // for ~30–60s before the media lands in the thread. Without a live indicator the
    // card just said "অনুমোদিত হয়েছে" and the UI looked frozen (owner report). Show a
    // generating state with working dots so it's clearly still in progress; the image
    // (and the agent's auto-continuation) then appear below when the worker finishes.
    const isAsyncGen = meta.actionType === 'image_gen' || meta.actionType === 'video_gen'
    if (isAsyncGen) {
      const genLabel = meta.actionType === 'video_gen'
        ? 'রিল তৈরি হচ্ছে… একটু সময় লাগবে, নিচে চলে আসবে'
        : 'ছবি তৈরি হচ্ছে… একটু সময় লাগবে, নিচে চলে আসবে'
      return (
        <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.18, ease: 'easeOut' }}
          className="mt-3 flex items-center justify-center gap-2.5 rounded-[18px] border tone-green px-4 py-5 text-sm shadow-float">
          <AgentWorkingDots className="shrink-0" />
          <span className="font-semibold text-cream/90">{genLabel}</span>
        </motion.div>
      )
    }
    return (
      <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.18, ease: 'easeOut' }}
        className="mt-3 rounded-[18px] border tone-green px-4 py-5 text-center text-sm shadow-float">
        <span className="text-3xl">{isDelegation ? '🤝' : '✅'}</span>
        <p className="mt-2 text-sm font-semibold">
          {isDelegation ? 'Worker কাজটি করছে — উত্তর নিচে আসবে' : 'অনুমোদিত হয়েছে'}
        </p>
      </motion.div>
    )
  }

  if (phase === 'rejected') {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.18, ease: 'easeOut' }}
        className={`mt-3 rounded-[18px] border px-4 py-5 text-center text-sm shadow-float ${isDelegation ? 'tone-amber' : 'tone-red'}`}>
        <span className="text-3xl">{isDelegation ? '🧠' : '❌'}</span>
        <p className="mt-2 text-sm font-semibold">
          {isDelegation ? 'ঠিক আছে — Sonnet নিজে উত্তর দিচ্ছে, নিচে আসবে' : 'বাতিল করা হয়েছে'}
        </p>
      </motion.div>
    )
  }

  if (phase === 'settled') {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.18, ease: 'easeOut' }}
        className="mt-3 rounded-[18px] border tone-slate px-4 py-5 text-center text-sm shadow-float">
        <span className="text-3xl">ℹ️</span>
        <p className="mt-2 text-sm font-medium">{terminalNote}</p>
      </motion.div>
    )
  }

  // ── Interactive approval: a Claude-Code floating liquid-glass bottom-sheet ──
  // Minimized → a slim inline pill in the thread that re-opens the sheet (so a
  // backdrop tap never loses a pending decision).
  if (minimized) {
    return (
      <motion.button
        type="button"
        onClick={() => setMinimized(false)}
        initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: 'easeOut' }}
        className="mt-3 flex w-full items-center gap-2 rounded-2xl border tone-amber px-3.5 py-2.5 text-left text-xs font-medium shadow-float"
      >
        <span aria-hidden>⚠️</span>
        <span className="min-w-0 flex-1 truncate">অনুমোদন প্রয়োজন — খুলতে ট্যাপ করুন</span>
        <span aria-hidden className="text-[13px] leading-none opacity-70">›</span>
      </motion.button>
    )
  }

  return (
    <MobileModalPortal
      open
      aria-label="অনুমোদন প্রয়োজন"
      onBackdropClick={() => setMinimized(true)}
      className="agent-confirm-sheet-overlay"
    >
      <div className="mobile-modal-shell alma-glass-sheet w-full max-w-lg rounded-t-[26px] sm:rounded-[24px]">
        {/* grab handle */}
        <div className="flex shrink-0 justify-center pb-1 pt-2.5">
          <span className="alma-sheet-grip" aria-hidden />
        </div>

        {/* header */}
        <div className="mobile-modal-header flex items-center gap-2 px-5 pb-2 pt-1">
          <span className="text-base" aria-hidden>⚠️</span>
          <span className="text-[15px] font-semibold tracking-[-0.01em] text-cream">অনুমোদন প্রয়োজন</span>
          <button
            type="button"
            onClick={() => setMinimized(true)}
            aria-label="ছোট করুন"
            className="ml-auto rounded-full p-1.5 text-muted transition-colors hover:bg-white/[0.06] hover:text-cream"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
          </button>
        </div>

        {/* body (scrollable) */}
        <div className="mobile-modal-body px-5 pb-2">
          <pre className="max-w-full overflow-x-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-sans text-[13px] leading-relaxed text-cream">{summary}</pre>

          {meta.actionType === 'oxylabs_spend' && meta.costEstimate != null && (
            <p className="mt-3 rounded-xl border tone-amber px-3 py-2 text-xs">
              Oxylabs prepaid credit: আনুমানিক <strong>{meta.costEstimate}</strong> ক্রেডিট খরচ হবে (USD নয়)।
              Reject করলে কোনো ক্রেডিট খরচ হবে না।
            </p>
          )}

          {meta.isBatch && (meta.entryCount ?? 0) > 0 && phase !== 'opinion' && (
            <div className="mt-3">
              <p className="mb-1.5 text-[11px] text-muted">কোনো এন্ট্রি বাদ দিতে ট্যাপ করুন:</p>
              <div className="flex flex-wrap gap-1.5">
                {Array.from({ length: meta.entryCount! }, (_, i) => (
                  <button key={i} type="button" onClick={() => void removeBatchItem(i)}
                    className="rounded-lg border tone-red px-2 py-1 text-[11px] hover:bg-red-500/20">
                    🗑️ {i + 1}
                  </button>
                ))}
              </div>
            </div>
          )}

          {phase === 'editing' && (
            <div className="mt-3 space-y-2 rounded-xl border border-border-subtle bg-card/70 p-3">
              {!editField ? (
                <div className="flex flex-wrap gap-2">
                  {(editFields.length ? editFields : Object.keys(EDIT_FIELDS)).map((f) => (
                    <button key={f} type="button" onClick={() => setEditField(f)}
                      className="rounded-lg border border-border-subtle bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-cream hover:border-[#E07A5F]/25 hover:bg-[#E07A5F]/5">
                      {EDIT_FIELDS[f] ?? f}
                    </button>
                  ))}
                  <button type="button" onClick={() => setPhase('idle')}
                    className="rounded-lg border border-border-subtle px-2.5 py-1.5 text-[11px] text-muted">বাতিল</button>
                </div>
              ) : (
                <>
                  <p className="text-[11px] text-muted">{EDIT_FIELDS[editField] ?? editField} — নতুন মান:</p>
                  <input value={editValue} onChange={(e) => setEditValue(e.target.value)}
                    className="w-full rounded-lg border border-border bg-card/80 px-2.5 py-2 text-[13px] text-cream focus:outline-none focus:border-[#E07A5F]/40" />
                  <button type="button" onClick={() => void applyEdit()}
                    className="rounded-lg border border-[#E07A5F]/25 bg-[#E07A5F]/10 px-3 py-1.5 text-[11px] text-[#E07A5F] hover:bg-[#E07A5F]/20">সংরক্ষণ</button>
                </>
              )}
            </div>
          )}

          {phase === 'opinion' && (
            <div className="mt-3 space-y-2">
              <p className="text-[12px] font-medium text-cream">আপনার মত লিখুন — এজেন্ট এটা অনুযায়ী কাজটা ঠিক করে দেবে:</p>
              <textarea
                value={opinionText}
                onChange={(e) => setOpinionText(e.target.value)}
                rows={3}
                autoFocus
                placeholder="যেমন: পরিমাণটা ৫০০ নয়, ৮০০ হবে…"
                className="w-full resize-none rounded-xl border border-border bg-card/70 px-3 py-2.5 text-[13px] leading-relaxed text-cream placeholder:text-muted/60 focus:border-[#E07A5F]/40 focus:outline-none"
              />
            </div>
          )}
        </div>

        {/* footer — action buttons */}
        <div className="mobile-modal-footer alma-glass-sheet border-t-0 px-5 pb-4 pt-3">
          {phase === 'opinion' ? (
            <div className="flex gap-2">
              <button type="button" onClick={() => setPhase('idle')}
                className="min-w-0 rounded-xl border border-border-subtle px-4 py-3 text-[13px] font-medium text-muted transition-colors hover:bg-white/[0.05]">
                ফিরে যান
              </button>
              <button type="button" onClick={() => void submitOpinion()} disabled={!opinionText.trim()}
                className="min-w-0 flex-1 rounded-xl border tone-amber px-4 py-3 text-[13px] font-semibold transition-all hover:bg-amber-500/20 disabled:opacity-40">
                📩 এজেন্টকে পাঠান
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <button type="button" onClick={() => resolve('approve')}
                className="w-full rounded-xl border tone-green px-4 py-3 text-[14px] font-semibold transition-all hover:bg-green-500/20 hover:shadow-sm">
                {meta.isBatch ? '✅ সব Approve' : '✓ Approve'}
              </button>
              <div className="flex gap-2">
                {meta.isFinance && (
                  <button type="button" onClick={() => setPhase('editing')}
                    className="min-w-0 flex-1 rounded-xl border tone-amber px-3 py-2.5 text-[12.5px] font-medium transition-all hover:bg-amber-500/20">
                    ✏️ সংশোধন
                  </button>
                )}
                {(REVISABLE_TYPES.has(meta.actionType ?? '') || onQuickSend) && (
                  <button type="button" onClick={() => setPhase('opinion')}
                    className="min-w-0 flex-1 rounded-xl border tone-purple px-3 py-2.5 text-[12.5px] font-medium transition-all hover:bg-purple-500/20">
                    💬 আমার মত
                  </button>
                )}
                <button type="button" onClick={() => resolve('reject')}
                  className="min-w-0 flex-1 rounded-xl border tone-red px-3 py-2.5 text-[12.5px] font-medium transition-all hover:bg-red-500/20">
                  ✗ Reject
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </MobileModalPortal>
  )
}
