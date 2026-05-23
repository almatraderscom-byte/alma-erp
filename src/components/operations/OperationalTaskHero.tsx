'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui'
import { PLATFORM_Z } from '@/lib/platform-z-index'
import type { OperationalTaskAssignmentDto } from '@/hooks/useOperationalTasks'
import {
  invalidateOperationalTasksCache,
  patchAssignmentAction,
} from '@/hooks/useOperationalTasks'
import { OPS_PRIORITY_BADGE } from '@/lib/operational-task-spotlight-client'

const PRIORITY_BADGE: Record<string, string> = {
  LOW: 'border-zinc-500/40 bg-zinc-500/15 text-zinc-300',
  NORMAL: OPS_PRIORITY_BADGE.NORMAL,
  HIGH: OPS_PRIORITY_BADGE.HIGH,
  CRITICAL: OPS_PRIORITY_BADGE.CRITICAL,
}

type Props = {
  businessId: string
  assignment: OperationalTaskAssignmentDto | null
  open: boolean
  onMinimize: () => void | Promise<void>
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
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!open) {
      setExpanded(false)
      return
    }
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  const blocking = Boolean(assignment?.task.acknowledgmentRequired)
  const canDismiss = Boolean(assignment?.task.allowDismiss)

  const finishAndClose = useCallback(async () => {
    await onMinimize()
    await onUpdated?.()
  }, [onMinimize, onUpdated])

  const acknowledgeAndStart = useCallback(async () => {
    if (!assignment || busy) return
    setBusy(true)
    try {
      const needsAck =
        assignment.task.acknowledgmentRequired && assignment.status === 'ACTIVE'
      if (needsAck) {
        await patchAssignmentAction(assignment.id, 'acknowledge')
      }
      await patchAssignmentAction(assignment.id, 'start')
      invalidateOperationalTasksCache(businessId)
      toast.success('Shift briefing acknowledged')
      await finishAndClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [assignment, busy, businessId, finishAndClose])

  const dismissTask = useCallback(async () => {
    if (!assignment || busy || !canDismiss) return
    setBusy(true)
    try {
      await patchAssignmentAction(assignment.id, 'dismiss')
      invalidateOperationalTasksCache(businessId)
      toast.success('Task dismissed')
      await finishAndClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [assignment, busy, businessId, canDismiss, finishAndClose])

  const continueWithoutAck = useCallback(async () => {
    if (!assignment || busy || blocking) return
    await finishAndClose()
  }, [assignment, busy, blocking, finishAndClose])

  useEffect(() => {
    if (!open || blocking) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void continueWithoutAck()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, blocking, continueWithoutAck])

  if (!mounted || !assignment) return null

  const t = assignment.task
  const badge = PRIORITY_BADGE[t.priority] || PRIORITY_BADGE.NORMAL
  const hasBanner = Boolean(t.bannerImageUrl)
  const deadlineLabel = t.deadline
    ? new Date(t.deadline).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : null

  return createPortal(
    <>
      <style>{`
        @keyframes opsHeroEnter {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: no-preference) {
          .ops-hero-animate { animation: opsHeroEnter 300ms ease-out both; }
        }
      `}</style>
      <AnimatePresence mode="wait">
        {open && (
          <div
            className="fixed inset-0 flex items-stretch justify-center sm:items-center sm:p-6"
            style={{ zIndex: PLATFORM_Z.fullScreenModal }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ops-hero-title"
          >
            <button
              type="button"
              aria-label="Close announcement"
              className="absolute inset-0 bg-black"
              onClick={() => {
                if (!blocking) void continueWithoutAck()
              }}
            />

            <div
              className="ops-hero-animate relative z-[1] flex h-[100dvh] w-full max-w-[480px] flex-col overflow-hidden bg-[#0a0a0a] sm:h-auto sm:max-h-[min(92dvh,900px)] sm:rounded-2xl sm:shadow-[0_24px_80px_rgba(0,0,0,0.65)] sm:ring-1 sm:ring-white/10"
              onClick={e => e.stopPropagation()}
            >
              {hasBanner ? (
                <div className="relative h-[50dvh] min-h-[220px] shrink-0 sm:h-[min(42vh,360px)]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={t.bannerImageUrl!}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover"
                    loading="eager"
                    decoding="async"
                  />
                  <div
                    className="absolute inset-0 bg-gradient-to-b from-black/20 via-black/40 to-[#0a0a0a]"
                    aria-hidden
                  />
                  <div className="absolute inset-x-0 bottom-0 px-6 pb-6 pt-16">
                    <span
                      className={`inline-flex rounded-full border px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider ${badge}`}
                    >
                      {t.priority}
                    </span>
                    <h1
                      id="ops-hero-title"
                      className="mt-3 text-2xl font-bold leading-tight text-cream sm:text-3xl"
                    >
                      {t.title}
                    </h1>
                  </div>
                </div>
              ) : (
                <div className="relative flex h-[38dvh] min-h-[200px] shrink-0 items-center justify-center overflow-hidden sm:h-[280px]">
                  <div
                    className="pointer-events-none absolute inset-0"
                    style={{
                      background:
                        'radial-gradient(ellipse 70% 60% at 50% 40%, rgba(212,175,55,0.14), transparent 70%)',
                    }}
                    aria-hidden
                  />
                  <span
                    className="pointer-events-none select-none text-[120px] font-black leading-none text-gold opacity-10 sm:text-[140px]"
                    aria-hidden
                  >
                    A
                  </span>
                </div>
              )}

              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-6 pb-4">
                {!hasBanner && (
                  <div className="pt-2">
                    <span
                      className={`inline-flex rounded-full border px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider ${badge}`}
                    >
                      {t.priority}
                    </span>
                    <h1
                      id={hasBanner ? undefined : 'ops-hero-title'}
                      className="mt-3 text-2xl font-bold leading-tight text-cream"
                    >
                      {t.title}
                    </h1>
                  </div>
                )}

                <div className={hasBanner ? 'pt-4' : 'pt-3'}>
                  <p
                    className={`text-base leading-relaxed text-zinc-300 ${expanded ? '' : 'line-clamp-4'}`}
                  >
                    {t.description}
                  </p>
                  {t.description.length > 180 && (
                    <button
                      type="button"
                      className="mt-2 text-xs font-semibold text-gold/90 hover:text-gold"
                      onClick={() => setExpanded(v => !v)}
                    >
                      {expanded ? 'Show less' : 'Read more'}
                    </button>
                  )}
                </div>

                <p className="mt-4 text-xs text-zinc-500">
                  From <span className="text-zinc-400">{t.assignedBy.name}</span>
                  {deadlineLabel && (
                    <>
                      {' '}
                      · <span className="text-amber-200/80">Due {deadlineLabel}</span>
                    </>
                  )}
                </p>
              </div>

              <div className="safe-bottom shrink-0 border-t border-white/10 bg-black/80 px-6 py-5 backdrop-blur-sm">
                <Button
                  variant="gold"
                  className="h-[52px] w-full justify-center text-base font-black"
                  disabled={busy}
                  onClick={() => void acknowledgeAndStart()}
                >
                  {busy ? 'Saving…' : 'Acknowledge & start my shift'}
                </Button>

                {canDismiss && (
                  <button
                    type="button"
                    className="mt-3 w-full text-center text-sm text-zinc-500 transition hover:text-zinc-300 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void dismissTask()}
                  >
                    Dismiss
                  </button>
                )}

                {!blocking && (
                  <button
                    type="button"
                    className="mt-4 w-full text-center text-xs text-zinc-600 transition hover:text-zinc-400 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void continueWithoutAck()}
                  >
                    Continue
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </AnimatePresence>
    </>,
    document.body,
  )
}
