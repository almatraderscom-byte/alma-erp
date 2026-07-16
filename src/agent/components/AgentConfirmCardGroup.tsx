'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import AgentConfirmCard, { type PendingAction } from './AgentConfirmCard'
import AgentSparkleLoader from './AgentSparkleLoader'
import { notifyTodosChanged } from './AgentTodoContext'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import { approvalSuccess, showPulseSuccess } from '@/lib/live-pulse'

interface AgentConfirmCardGroupProps {
  actions: PendingAction[]
  onResolved: (status: 'approved' | 'rejected') => void
  onQuickSend?: (text: string) => void
}

const TERMINAL_NOTES: Record<string, string> = {
  already_resolved: 'এই কার্ডটি আগেই প্রসেস হয়ে গেছে ✓',
  expired: 'সময় শেষ — কার্ডটি আর সক্রিয় নেই (৩০ মিনিটের সীমা)।',
  not_found: 'কার্ডটি আর পাওয়া যাচ্ছে না — সম্ভবত আগেই প্রসেস হয়েছে।',
}

async function postDecision(id: string, decision: 'approve' | 'reject'): Promise<void> {
  const res = await fetch(`/api/assistant/actions/${id}/${decision}`, { method: 'POST' })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    // Already-handled / expired / gone → treat as done, not a crash.
    if (err.error && TERMINAL_NOTES[err.error]) return
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  // Flash the Dynamic Panel's success state — only here, where the server has
  // actually confirmed (spec §6.6). It falls back to authoritative live state on
  // the next sync.
  if (decision === 'approve') void showPulseSuccess(approvalSuccess())
}

/**
 * Groups several pending actions from ONE agent turn into a single floating
 * approval sheet. A single action (or any delegation) falls straight through to
 * the standalone AgentConfirmCard so its bespoke flow (edit / batch-remove /
 * delegation chip) is untouched. Grouping only kicks in for 2+ actionable,
 * non-delegation actions — the case the owner reported (expense + post shown as
 * one incomplete card).
 */
export default function AgentConfirmCardGroup({ actions, onResolved, onQuickSend }: AgentConfirmCardGroupProps) {
  const resolvedHistory = actions.filter((a) => a.resolvedStatus && a.resolvedStatus !== 'pending')
  const live = actions.filter((a) => !a.resolvedStatus || a.resolvedStatus === 'pending')
  const groupable = live.filter((a) => a.actionType !== 'delegation')
  const standalone = [...resolvedHistory, ...live.filter((a) => a.actionType === 'delegation')]

  const useGroup = groupable.length > 1

  return (
    <>
      {/* Reloaded-from-history breadcrumbs + delegation chips keep their own card. */}
      {standalone.map((a) => (
        <AgentConfirmCard key={a.id} action={a} onQuickSend={onQuickSend} onResolved={onResolved} />
      ))}
      {/* A lone actionable card also keeps the standalone flow (edit/batch). */}
      {!useGroup && groupable.map((a) => (
        <AgentConfirmCard key={a.id} action={a} onQuickSend={onQuickSend} onResolved={onResolved} />
      ))}
      {useGroup && <GroupedSheet actions={groupable} onResolved={onResolved} onQuickSend={onQuickSend} />}
    </>
  )
}

function GroupedSheet({ actions, onResolved, onQuickSend }: { actions: PendingAction[]; onResolved: (s: 'approved' | 'rejected') => void; onQuickSend?: (t: string) => void }) {
  // Per-item settled state so approved/rejected items become badges while the
  // rest stay actionable.
  const [decided, setDecided] = useState<Record<string, 'approved' | 'rejected'>>({})
  const [busy, setBusy] = useState(false)
  const [opinionFor, setOpinionFor] = useState<string | null>(null)
  const [opinionText, setOpinionText] = useState('')
  const [minimized, setMinimized] = useState(false)

  const pending = actions.filter((a) => !decided[a.id])
  const allDone = pending.length === 0

  async function approveAll() {
    if (busy) return
    setBusy(true)
    const targets = actions.filter((a) => !decided[a.id])
    try {
      await Promise.all(targets.map((a) => postDecision(a.id, 'approve')))
      setDecided((prev) => {
        const next = { ...prev }
        for (const a of targets) next[a.id] = 'approved'
        return next
      })
      toast.success('সব অনুমোদিত ✓')
      onResolved('approved')
      notifyTodosChanged()
    } catch (err) {
      toast.error(`সমস্যা: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function rejectOne(id: string) {
    if (busy) return
    setBusy(true)
    try {
      await postDecision(id, 'reject')
      setDecided((prev) => ({ ...prev, [id]: 'rejected' }))
      toast.success('একটি বাতিল করা হয়েছে')
      onResolved('rejected')
      notifyTodosChanged()
    } catch (err) {
      toast.error(`সমস্যা: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function sendOpinion(id: string) {
    const note = opinionText.trim()
    if (!note) return
    setBusy(true)
    try {
      await fetch(`/api/assistant/actions/${id}/reject`, { method: 'POST' }).catch(() => {})
      setDecided((prev) => ({ ...prev, [id]: 'rejected' }))
      onResolved('rejected')
      notifyTodosChanged()
      onQuickSend?.(note)
      setOpinionFor(null)
      setOpinionText('')
      toast.success('আপনার মত এজেন্টকে পাঠানো হয়েছে')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (minimized) {
    return (
      <motion.button
        type="button"
        onClick={() => setMinimized(false)}
        initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: 'easeOut' }}
        className="mt-3 flex w-full items-center gap-2 rounded-2xl border tone-amber px-3.5 py-2.5 text-left text-xs font-medium shadow-float"
      >
        <span aria-hidden>⚠️</span>
        <span className="min-w-0 flex-1 truncate">{pending.length}টি অনুমোদন প্রয়োজন — খুলতে ট্যাপ করুন</span>
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
        <div className="flex shrink-0 justify-center pb-1 pt-2.5">
          <span className="alma-sheet-grip" aria-hidden />
        </div>

        <div className="mobile-modal-header flex items-center gap-2 px-5 pb-2 pt-1">
          <span className="text-base" aria-hidden>⚠️</span>
          <span className="text-[15px] font-semibold tracking-[-0.01em] text-cream">
            অনুমোদন প্রয়োজন{pending.length > 0 ? ` · ${pending.length}টি কাজ` : ''}
          </span>
          <button
            type="button"
            onClick={() => setMinimized(true)}
            aria-label="ছোট করুন"
            className="ml-auto rounded-full p-1.5 text-muted transition-colors hover:bg-white/[0.06] hover:text-cream"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
          </button>
        </div>

        <div className="mobile-modal-body space-y-2.5 px-5 pb-2">
          {allDone ? (
            <div className="rounded-xl border tone-slate px-3.5 py-4 text-center text-sm">
              <span className="text-2xl">ℹ️</span>
              <p className="mt-1.5 font-medium text-cream/90">সব সিদ্ধান্ত নেওয়া হয়েছে</p>
            </div>
          ) : (
            actions.map((a, i) => {
              const status = decided[a.id]
              return (
                <div
                  key={a.id}
                  className={`rounded-2xl border px-3.5 py-3 ${status === 'approved' ? 'tone-green' : status === 'rejected' ? 'tone-red' : 'border-border-subtle bg-card/60'}`}
                >
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-[11px] font-semibold text-cream/80">{i + 1}</span>
                    {a.isFinance && <span className="text-[11px]" aria-hidden>💰</span>}
                    {status && (
                      <span className="ml-auto text-[11px] font-semibold">
                        {status === 'approved' ? '✅ অনুমোদিত' : '❌ বাতিল'}
                      </span>
                    )}
                  </div>
                  <pre className="max-w-full overflow-x-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-sans text-[12.5px] leading-relaxed text-cream">{a.summary}</pre>

                  {!status && opinionFor === a.id && (
                    <div className="mt-2 space-y-2">
                      <textarea
                        value={opinionText}
                        onChange={(e) => setOpinionText(e.target.value)}
                        rows={2}
                        autoFocus
                        placeholder="যেমন: পরিমাণটা ৫০০ নয়, ৮০০ হবে…"
                        className="w-full resize-none rounded-xl border border-border bg-card/70 px-3 py-2 text-[12.5px] leading-relaxed text-cream placeholder:text-muted/60 focus:border-[#E07A5F]/40 focus:outline-none"
                      />
                      <div className="flex gap-2">
                        <button type="button" onClick={() => { setOpinionFor(null); setOpinionText('') }}
                          className="rounded-lg border border-border-subtle px-3 py-1.5 text-[11px] text-muted">ফিরে যান</button>
                        <button type="button" disabled={!opinionText.trim() || busy} onClick={() => void sendOpinion(a.id)}
                          className="flex-1 rounded-lg border tone-amber px-3 py-1.5 text-[11px] font-semibold disabled:opacity-40">📩 পাঠান</button>
                      </div>
                    </div>
                  )}

                  {!status && opinionFor !== a.id && (
                    <div className="mt-2 flex gap-2">
                      {onQuickSend && (
                        <button type="button" disabled={busy} onClick={() => { setOpinionFor(a.id); setOpinionText('') }}
                          className="min-w-0 flex-1 rounded-lg border tone-purple px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:bg-purple-500/20 disabled:opacity-40">
                          💬 আমার মত
                        </button>
                      )}
                      <button type="button" disabled={busy} onClick={() => void rejectOne(a.id)}
                        className="min-w-0 flex-1 rounded-lg border tone-red px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:bg-red-500/20 disabled:opacity-40">
                        ✗ Reject
                      </button>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        <div className="mobile-modal-footer alma-glass-sheet border-t-0 px-5 pb-4 pt-3">
          {busy ? (
            <div className="flex items-center justify-center py-2">
              <AgentSparkleLoader label="প্রক্রিয়া হচ্ছে…" size="lg" />
            </div>
          ) : (
            <button type="button" onClick={() => void approveAll()} disabled={allDone}
              className="w-full rounded-xl border tone-green px-4 py-3 text-[14px] font-semibold transition-all hover:bg-green-500/20 hover:shadow-sm disabled:opacity-40">
              ✅ সব Approve{pending.length > 0 ? ` (${pending.length})` : ''}
            </button>
          )}
        </div>
      </div>
    </MobileModalPortal>
  )
}
