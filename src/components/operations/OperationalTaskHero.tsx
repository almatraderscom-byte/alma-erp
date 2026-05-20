'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui'
import { PLATFORM_Z } from '@/lib/platform-z-index'
import type { OperationalTaskAssignmentDto } from '@/hooks/useOperationalTasks'
import {
  invalidateOperationalTasksCache,
  patchAssignmentAction,
} from '@/hooks/useOperationalTasks'
import {
  OPS_PRIORITY_BADGE,
  OPS_PRIORITY_GLOW,
} from '@/lib/operational-task-spotlight-client'

type Props = {
  businessId: string
  assignment: OperationalTaskAssignmentDto | null
  open: boolean
  onMinimize: () => void
  onUpdated?: () => void | Promise<void>
}

export function OperationalTaskHero({
  businessId,
  assignment,
  open,
  onMinimize,
  onUpdated,
}: Props) {
  const [mounted, setMounted] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [celebrate, setCelebrate] = useState(false)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  const runAction = useCallback(
    async (action: 'acknowledge' | 'start' | 'complete') => {
      if (!assignment || busy) return
      setBusy(action)
      try {
        await patchAssignmentAction(assignment.id, action)
        invalidateOperationalTasksCache(businessId)
        if (action === 'complete') {
          setCelebrate(true)
          toast.success('Mission complete')
          window.setTimeout(() => {
            setCelebrate(false)
            onMinimize()
            void onUpdated?.()
          }, 720)
          return
        }
        await onUpdated?.()
        if (action === 'acknowledge') toast.success('Acknowledged')
        if (action === 'start') toast.success('Task in progress')
      } catch (e) {
        toast.error((e as Error).message)
      } finally {
        setBusy(null)
      }
    },
    [assignment, busy, businessId, onMinimize, onUpdated],
  )

  if (!mounted || !assignment) return null

  const t = assignment.task
  const needsAck = t.acknowledgmentRequired && assignment.status === 'ACTIVE'
  const glow = OPS_PRIORITY_GLOW[t.priority] || OPS_PRIORITY_GLOW.NORMAL
  const badge = OPS_PRIORITY_BADGE[t.priority] || OPS_PRIORITY_BADGE.NORMAL

  return createPortal(
    <AnimatePresence mode="wait">
      {open && (
        <motion.div
          className="fixed inset-0 flex items-center justify-center p-0 sm:p-6"
          style={{ zIndex: PLATFORM_Z.fullScreenModal }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.24 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="ops-hero-title"
        >
          <div className="absolute inset-0 bg-[#030308]/92" aria-hidden />
          <div
            className="pointer-events-none absolute inset-0 opacity-60"
            style={{
              background:
                'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(212,175,55,0.22), transparent 55%), radial-gradient(ellipse 60% 40% at 100% 100%, rgba(56,189,248,0.08), transparent 50%)',
            }}
            aria-hidden
          />

          <motion.div
            className={`relative mx-auto flex w-full max-w-2xl max-h-[min(100dvh,100svh)] flex-col overflow-hidden rounded-none border border-white/10 bg-[#08080e]/90 sm:max-h-[min(92dvh,920px)] sm:rounded-[28px] ring-1 backdrop-blur-md ${glow} ${celebrate ? 'ring-green-400/50' : ''}`}
            initial={{ opacity: 0, scale: 0.94, y: 20 }}
            animate={{ opacity: celebrate ? 1 : 1, scale: celebrate ? 1.02 : 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 12 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="safe-top shrink-0 px-6 pt-8 pb-5 text-center sm:px-10 sm:pt-10">
              <p className="text-[11px] font-black uppercase tracking-[0.28em] text-gold/80">
                Operational briefing
              </p>
              <h1
                id="ops-hero-title"
                className="mt-4 text-2xl font-black leading-[1.15] text-cream sm:text-4xl"
              >
                {t.title}
              </h1>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <span
                  className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-wider ${badge}`}
                >
                  {t.priority}
                </span>
                <span className="text-xs text-zinc-500">Command · {t.assignedBy.name}</span>
                {t.deadline && (
                  <span className="text-xs text-amber-200/90">
                    Due {new Date(t.deadline).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-4 sm:px-10">
              {t.bannerImageUrl && (
                <div className="mb-6 overflow-hidden rounded-2xl border border-white/10">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={t.bannerImageUrl}
                    alt=""
                    className="max-h-[min(36vh,280px)] w-full object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                </div>
              )}
              <p className="text-center text-sm leading-relaxed text-zinc-300 sm:text-base sm:leading-loose">
                {t.description}
              </p>
            </div>

            <div className="safe-bottom shrink-0 border-t border-white/10 bg-black/50 px-6 py-5 sm:px-10">
              <div className="mx-auto grid max-w-md gap-2.5">
                {needsAck && (
                  <Button
                    variant="secondary"
                    className="h-12 w-full justify-center font-bold"
                    disabled={busy !== null}
                    onClick={() => void runAction('acknowledge')}
                  >
                    {busy === 'acknowledge' ? 'Saving…' : 'I acknowledge'}
                  </Button>
                )}
                <Button
                  variant="gold"
                  className="h-[52px] w-full justify-center text-base font-black"
                  disabled={busy !== null}
                  onClick={() => void runAction('start')}
                >
                  {busy === 'start' ? 'Starting…' : 'Start task'}
                </Button>
                <Button
                  variant="secondary"
                  className="h-12 w-full justify-center font-semibold"
                  disabled={busy !== null}
                  onClick={onMinimize}
                >
                  Continue to dashboard
                </Button>
                <button
                  type="button"
                  className="text-center text-xs text-zinc-500 transition hover:text-zinc-300 disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => void runAction('complete')}
                >
                  {busy === 'complete' ? 'Completing…' : 'Mark complete'}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
