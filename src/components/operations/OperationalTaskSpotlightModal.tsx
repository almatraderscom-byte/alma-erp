'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui'
import type { OperationalTaskAssignmentDto } from '@/hooks/useOperationalTasks'
import {
  invalidateOperationalTasksCache,
  markSpotlightShownSession,
  patchAssignmentAction,
} from '@/hooks/useOperationalTasks'

const PRIORITY_STYLES: Record<string, string> = {
  LOW: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  NORMAL: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
  HIGH: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  CRITICAL: 'border-red-500/50 bg-red-500/15 text-red-200',
}

type Props = {
  businessId: string
  assignment: OperationalTaskAssignmentDto | null
  open: boolean
  onClose: () => void
  onUpdated?: () => void
}

export function OperationalTaskSpotlightModal({
  businessId,
  assignment,
  open,
  onClose,
  onUpdated,
}: Props) {
  const [mounted, setMounted] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && assignment?.task.allowDismiss) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, assignment?.task.allowDismiss])

  const runAction = useCallback(
    async (action: 'acknowledge' | 'start' | 'complete' | 'dismiss') => {
      if (!assignment || busy) return
      setBusy(action)
      try {
        await patchAssignmentAction(assignment.id, action)
        invalidateOperationalTasksCache(businessId)
        if (action === 'complete' || action === 'dismiss') {
          markSpotlightShownSession(assignment.id)
          onClose()
        }
        onUpdated?.()
        if (action === 'acknowledge') toast.success('Acknowledged')
        if (action === 'start') toast.success('Task started')
        if (action === 'complete') toast.success('Task completed')
      } catch (e) {
        toast.error((e as Error).message)
      } finally {
        setBusy(null)
      }
    },
    [assignment, busy, businessId, onClose, onUpdated],
  )

  if (!mounted || !open || !assignment) return null

  const t = assignment.task
  const needsAck = t.acknowledgmentRequired && assignment.status === 'ACTIVE'
  const canDismiss = t.allowDismiss

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[10060] flex items-end justify-center sm:items-center sm:p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="ops-spotlight-title"
        >
          <button
            type="button"
            aria-label="Close spotlight"
            className="absolute inset-0 bg-black/85 backdrop-blur-[2px]"
            onClick={() => {
              if (canDismiss) onClose()
            }}
          />
          <motion.div
            className="relative z-[10061] mx-auto flex w-full max-w-lg max-h-[min(100dvh,100svh)] flex-col overflow-hidden rounded-t-[28px] border border-white/10 bg-[#0a0a0f]/95 shadow-[0_0_60px_rgba(212,175,55,0.12)] sm:max-h-[92dvh] sm:rounded-2xl"
            initial={{ opacity: 0, scale: 0.96, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 12 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-gold/20 via-gold/5 to-transparent" />
            <div className="safe-top relative shrink-0 border-b border-white/10 px-5 pb-4 pt-5">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-gold/90">
                Operational spotlight
              </p>
              <h2 id="ops-spotlight-title" className="mt-2 text-xl font-black text-cream leading-tight">
                {t.title}
              </h2>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full border px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider ${PRIORITY_STYLES[t.priority] || PRIORITY_STYLES.NORMAL}`}
                >
                  {t.priority}
                </span>
                <span className="text-[11px] text-zinc-500">
                  From {t.assignedBy.name}
                </span>
                {t.deadline && (
                  <span className="text-[11px] text-amber-300/90">
                    Due {new Date(t.deadline).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                )}
              </div>
            </div>

            <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
              {t.bannerImageUrl && (
                <div className="mb-4 overflow-hidden rounded-xl border border-white/10 ring-1 ring-gold/20">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={t.bannerImageUrl}
                    alt=""
                    className="max-h-40 w-full object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                </div>
              )}
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">{t.description}</p>
            </div>

            <div className="safe-bottom relative shrink-0 border-t border-white/10 bg-black/40 px-5 py-4 backdrop-blur-md">
              <div className="grid gap-2">
                {needsAck && (
                  <Button
                    variant="gold"
                    className="h-12 w-full justify-center font-black"
                    disabled={busy !== null}
                    onClick={() => void runAction('acknowledge')}
                  >
                    {busy === 'acknowledge' ? 'Saving…' : 'I acknowledge'}
                  </Button>
                )}
                <Button
                  variant="gold"
                  className="h-12 w-full justify-center font-black"
                  disabled={busy !== null}
                  onClick={() => void runAction(needsAck ? 'start' : 'start')}
                >
                  {busy === 'start' ? 'Starting…' : 'Start task'}
                </Button>
                <Button
                  variant="secondary"
                  className="h-11 w-full justify-center"
                  disabled={busy !== null}
                  onClick={() => void runAction('complete')}
                >
                  {busy === 'complete' ? 'Saving…' : 'Mark completed'}
                </Button>
                {canDismiss && (
                  <button
                    type="button"
                    className="mt-1 text-center text-xs text-zinc-500 hover:text-zinc-300"
                    disabled={busy !== null}
                    onClick={() => void runAction('dismiss')}
                  >
                    Dismiss for now
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
