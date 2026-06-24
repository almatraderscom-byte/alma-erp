'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import AgentSparkleLoader from './AgentSparkleLoader'
import AgentWorkingDots from './AgentWorkingDots'
import { notifyTodosChanged } from './AgentTodoContext'

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
}

/** Settled-record presentation for a confirm card rebuilt from history. */
const RESOLVED_RECORD: Record<string, { icon: string; label: string; tone: string; text: string }> = {
  approved: { icon: '✅', label: 'অনুমোদিত', tone: 'border-emerald-200 bg-emerald-50 text-emerald-700', text: 'আপনি অনুমোদন করেছিলেন' },
  executed: { icon: '✅', label: 'অনুমোদিত ও সম্পন্ন', tone: 'border-emerald-200 bg-emerald-50 text-emerald-700', text: 'আপনি অনুমোদন করেছিলেন — কাজটি সম্পন্ন হয়েছে' },
  rejected: { icon: '❌', label: 'বাতিল', tone: 'border-red-200 bg-red-50 text-red-600', text: 'আপনি বাতিল করেছিলেন' },
  expired: { icon: '⏱️', label: 'সময় শেষ', tone: 'border-slate-200 bg-slate-50 text-slate-600', text: 'সময় শেষ হয়ে গিয়েছিল — সিদ্ধান্ত নেওয়া হয়নি' },
  failed: { icon: '⚠️', label: 'ব্যর্থ', tone: 'border-amber-200 bg-amber-50 text-amber-700', text: 'অনুমোদন করেছিলেন, কিন্তু কাজটি ব্যর্থ হয়েছে' },
}

type CardPhase = 'idle' | 'loading' | 'approved' | 'rejected' | 'editing' | 'settled'

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
}

const EDIT_FIELDS: Record<string, string> = {
  amount: '💰 পরিমাণ',
  personName: '👤 নাম',
  category: '📂 ক্যাটাগরি',
  direction: '↔️ দিক',
  currency: '💱 মুদ্রা',
  note: '📝 নোট',
}

export default function AgentConfirmCard({ action, onResolved, onUpdated }: AgentConfirmCardProps) {
  const [phase, setPhase] = useState<CardPhase>('idle')
  const [loadingDecision, setLoadingDecision] = useState<'approve' | 'reject' | null>(null)
  const [summary, setSummary] = useState(action.summary)
  const [meta, setMeta] = useState(action)
  const [editField, setEditField] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editFields, setEditFields] = useState<string[]>([])
  const [terminalNote, setTerminalNote] = useState('')

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
        className={`mt-3 w-full max-w-full overflow-hidden rounded-2xl border px-3.5 py-2.5 text-xs shadow-card ${rec.tone}`}
      >
        <div className="flex items-center gap-1.5 font-semibold">
          <span aria-hidden>{rec.icon}</span>
          <span>{rec.label}</span>
          <span className="ml-auto text-[10px] font-normal opacity-70">{rec.text}</span>
        </div>
        <pre className="mt-1.5 max-w-full overflow-x-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-sans text-[11px] leading-relaxed text-cream opacity-90">{action.summary}</pre>
      </motion.div>
    )
  }

  async function resolve(decision: 'approve' | 'reject') {
    if (phase !== 'idle' && phase !== 'editing') return
    setPhase('loading')
    setLoadingDecision(decision)
    try {
      const res = await fetch(`/api/assistant/actions/${action.id}/${decision}`, { method: 'POST' })
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
      toast.success(decision === 'approve' ? 'অনুমোদিত ✓' : 'বাতিল করা হয়েছে')
      onResolved(decision === 'approve' ? 'approved' : 'rejected')
      // A resolved card may have cancelled/created a todo (e.g. todo_cancel) —
      // refresh the dock immediately so it doesn't linger until the next poll.
      notifyTodosChanged()
    } catch (err) {
      toast.error(`সমস্যা: ${err instanceof Error ? err.message : String(err)}`)
      setPhase('idle')
      setLoadingDecision(null)
    }
  }

  async function removeBatchItem(index: number) {
    try {
      const res = await fetch(`/api/assistant/actions/${action.id}`, {
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
      const res = await fetch(`/api/assistant/actions/${action.id}`, {
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

  // iPhone fix: NO framer `layout` prop on these cards. `layout` re-measures the
  // element on every surrounding change (streaming text growing above it, the
  // auto-scroll) and animates the delta with a transform — on the width-locked
  // WKWebView that read as the whole card briefly zooming/scaling and its right
  // edge (the "Sonnet বলুক" button) getting clipped. Plain enter animation only.
  const isDelegation = meta.actionType === 'delegation'

  const loadingLabel =
    loadingDecision === 'approve'
      ? (isDelegation ? 'Worker কাজ শুরু করছে…' : 'অনুমোদন প্রক্রিয়া হচ্ছে…')
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
          className="mt-3 flex items-center gap-2.5 rounded-2xl border border-border-subtle bg-card/70 px-3.5 py-2.5 shadow-card backdrop-blur-sm">
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
          className={`mt-3 flex items-center gap-2.5 rounded-2xl border px-3.5 py-2.5 shadow-card ${tone}`}>
          <span className="shrink-0 text-base leading-none">{isApproved ? '🤝' : isRejected ? '🧠' : 'ℹ️'}</span>
          <span className="min-w-0 flex-1 text-xs font-medium text-cream/90">{note}</span>
          {ongoing && <AgentWorkingDots className="shrink-0" />}
        </motion.div>
      )
    }
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: 'easeOut' }}
        className="mt-3 w-full max-w-full overflow-hidden rounded-2xl border border-amber-200 bg-amber-50/50 px-3 py-2.5 text-xs shadow-card">
        <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-amber-700">
          <span>🤝</span><span>কে করবে?</span>
        </div>
        <p className="mb-2.5 break-words [overflow-wrap:anywhere] leading-relaxed text-cream">{summary}</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => resolve('approve')}
            className="min-w-0 flex-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[11px] font-medium text-emerald-600 transition-colors hover:bg-emerald-100">
            Worker
          </button>
          <button type="button" onClick={() => resolve('reject')}
            className="min-w-0 flex-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-[11px] font-medium text-indigo-600 transition-colors hover:bg-indigo-100">
            Sonnet
          </button>
        </div>
      </motion.div>
    )
  }

  if (phase === 'loading') {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: 'easeOut' }}
        className="mt-3 flex min-h-[140px] items-center justify-center rounded-[18px] border border-amber-200 bg-amber-50/50 p-6 shadow-card">
        <AgentSparkleLoader label={loadingLabel} size="lg" />
      </motion.div>
    )
  }

  if (phase === 'approved') {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.18, ease: 'easeOut' }}
        className="mt-3 rounded-[18px] border border-emerald-200 bg-emerald-50 px-4 py-5 text-center text-sm shadow-card">
        <span className="text-3xl">{isDelegation ? '🤝' : '✅'}</span>
        <p className="mt-2 text-sm font-semibold text-emerald-600">
          {isDelegation ? 'Worker কাজটি করছে — উত্তর নিচে আসবে' : 'অনুমোদিত হয়েছে'}
        </p>
      </motion.div>
    )
  }

  if (phase === 'rejected') {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.18, ease: 'easeOut' }}
        className={`mt-3 rounded-[18px] border px-4 py-5 text-center text-sm shadow-card ${isDelegation ? 'border-amber-200 bg-amber-50' : 'border-red-200 bg-red-50'}`}>
        <span className="text-3xl">{isDelegation ? '🧠' : '❌'}</span>
        <p className={`mt-2 text-sm font-semibold ${isDelegation ? 'text-amber-600' : 'text-red-500'}`}>
          {isDelegation ? 'ঠিক আছে — Sonnet নিজে উত্তর দিচ্ছে, নিচে আসবে' : 'বাতিল করা হয়েছে'}
        </p>
      </motion.div>
    )
  }

  if (phase === 'settled') {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.18, ease: 'easeOut' }}
        className="mt-3 rounded-[18px] border border-slate-200 bg-slate-50 px-4 py-5 text-center text-sm shadow-card">
        <span className="text-3xl">ℹ️</span>
        <p className="mt-2 text-sm font-medium text-slate-600">{terminalNote}</p>
      </motion.div>
    )
  }

  return (
    <motion.div className="mt-3 w-full max-w-full overflow-hidden rounded-[18px] border border-amber-200 bg-amber-50/50 p-4 text-sm shadow-card"
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: 'easeOut' }}>
      <div className="mb-1 flex items-center gap-2 font-semibold text-amber-700">
        <span>{isDelegation ? '🤝' : '⚠️'}</span>
        <span>{isDelegation ? 'কে কাজটি করবে?' : 'অনুমোদন প্রয়োজন'}</span>
      </div>
      <pre className="mb-3 max-w-full overflow-x-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-sans text-xs leading-relaxed text-cream">{summary}</pre>

      {isDelegation && (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
          <strong>Worker করুক</strong> → সস্তা মডেল কাজটি করবে (কম খরচ)। <strong>Sonnet বলুক</strong> → আমি নিজে এখনই উত্তর দেব (বেশি খরচ)। আপনি বেছে নিন।
        </p>
      )}

      {meta.actionType === 'oxylabs_spend' && meta.costEstimate != null && (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Oxylabs prepaid credit: আনুমানিক <strong>{meta.costEstimate}</strong> ক্রেডিট খরচ হবে (USD নয়)।
          Reject করলে কোনো ক্রেডিট খরচ হবে না।
        </p>
      )}

      {meta.isBatch && (meta.entryCount ?? 0) > 0 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {Array.from({ length: meta.entryCount! }, (_, i) => (
            <button key={i} type="button" onClick={() => void removeBatchItem(i)}
              className="rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[10px] text-red-600 hover:bg-red-100">
              🗑️ {i + 1}
            </button>
          ))}
        </div>
      )}

      {phase === 'editing' && (
        <div className="mb-3 space-y-2 rounded-lg border border-border-subtle bg-card/80 p-3">
          {!editField ? (
            <div className="flex flex-wrap gap-2">
              {(editFields.length ? editFields : Object.keys(EDIT_FIELDS)).map((f) => (
                <button key={f} type="button" onClick={() => setEditField(f)}
                  className="rounded-lg border border-border-subtle bg-white/[0.04] px-2 py-1 text-[10px] text-cream hover:border-[#E07A5F]/25 hover:bg-[#E07A5F]/5">
                  {EDIT_FIELDS[f] ?? f}
                </button>
              ))}
              <button type="button" onClick={() => setPhase('idle')}
                className="rounded-lg border border-border-subtle px-2 py-1 text-[10px] text-muted">বাতিল</button>
            </div>
          ) : (
            <>
              <p className="text-[10px] text-muted">{EDIT_FIELDS[editField] ?? editField} — নতুন মান:</p>
              <input value={editValue} onChange={(e) => setEditValue(e.target.value)}
                className="w-full rounded-lg border border-border bg-card/80 px-2 py-1.5 text-xs text-cream focus:outline-none focus:border-[#E07A5F]/40" />
              <button type="button" onClick={() => void applyEdit()}
                className="rounded-lg bg-[#E07A5F]/10 border border-[#E07A5F]/25 px-3 py-1.5 text-[10px] text-[#E07A5F] hover:bg-[#E07A5F]/20">সংরক্ষণ</button>
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => resolve('approve')}
          className="min-w-0 flex-1 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs font-medium text-emerald-600 transition-all hover:bg-emerald-100 hover:shadow-sm">
          {isDelegation ? '✅ Worker করুক' : meta.isBatch ? '✅ সব Approve' : '✓ Approve'}
        </button>
        {meta.isFinance && (
          <button type="button" onClick={() => setPhase('editing')}
            className="min-w-0 flex-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs font-medium text-amber-600 transition-all hover:bg-amber-100 hover:shadow-sm">
            ✏️ সংশোধন
          </button>
        )}
        <button type="button" onClick={() => resolve('reject')}
          className={`min-w-0 flex-1 rounded-lg border px-3 py-2.5 text-xs font-medium transition-all hover:shadow-sm ${isDelegation ? 'border-indigo-200 bg-indigo-50 text-indigo-600 hover:bg-indigo-100' : 'border-red-200 bg-red-50 text-red-500 hover:bg-red-100'}`}>
          {isDelegation ? '🧠 Sonnet বলুক' : '✗ Reject'}
        </button>
      </div>
    </motion.div>
  )
}
