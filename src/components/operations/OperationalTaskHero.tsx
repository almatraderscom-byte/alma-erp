'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
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

function AlmaBrandMark({ className = '' }: { className?: string }) {
  return (
    <span
      className={`pointer-events-none select-none font-serif font-semibold leading-none text-gold ${className}`}
      aria-hidden
    >
      A
    </span>
  )
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
  const priority = t.priority
  const badge = PRIORITY_BADGE[priority] || PRIORITY_BADGE.NORMAL
  const hasBanner = Boolean(t.bannerImageUrl)
  const deadlineLabel = t.deadline
    ? new Date(t.deadline).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : null

  const copyBlock = (
    <>
      <p className="text-[10px] font-black uppercase tracking-[0.3em] text-gold-dim">Alma</p>
      <div className="mt-4 h-0.5 w-10 rounded-full bg-gold/70" aria-hidden />
      <span
        className={`mt-5 inline-flex rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-wider ${badge}`}
      >
        {priority}
      </span>
      <h1
        id="ops-hero-title"
        className="mt-5 max-w-sm text-3xl font-bold tracking-wide text-white"
      >
        {t.title}
      </h1>
      <p
        className={`mt-4 max-w-sm text-base leading-relaxed text-zinc-400 ${expanded ? '' : 'line-clamp-4'}`}
      >
        {t.description}
      </p>
      {t.description.length > 160 && (
        <button
          type="button"
          className="mt-2 text-xs font-semibold text-gold/90 hover:text-gold"
          onClick={() => setExpanded(v => !v)}
        >
          {expanded ? 'Show less' : 'Read more'}
        </button>
      )}
      <p className="mt-5 text-xs text-zinc-500">
        {t.assignedBy.name}
        {deadlineLabel ? ` · Due ${deadlineLabel}` : ''}
      </p>
    </>
  )

  const actionBlock = (
    <div className="shrink-0 border-t border-white/5 bg-black px-6 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
      <button
        type="button"
        className="w-full rounded-xl bg-gold py-4 text-center text-base font-black text-black transition hover:bg-gold-lt disabled:opacity-60"
        disabled={busy}
        onClick={() => void acknowledgeAndStart()}
      >
        {busy ? 'Saving…' : 'Acknowledge & start my shift'}
      </button>
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
  )

  return createPortal(
    <>
      <style>{`
        @keyframes opsHeroOverlayIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes opsHeroContentIn {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes opsHeroWatermarkIn {
          from { opacity: 0; transform: scale(0.9); }
          to { opacity: 0.15; transform: scale(1); }
        }
        @media (prefers-reduced-motion: no-preference) {
          .ops-hero-overlay-in { animation: opsHeroOverlayIn 200ms ease-out both; }
          .ops-hero-content-in { animation: opsHeroContentIn 400ms ease-out 200ms both; }
          .ops-hero-watermark-in { animation: opsHeroWatermarkIn 600ms ease-out both; }
        }
      `}</style>
      <AnimatePresence mode="wait">
        {open && (
          <div
            className="ops-hero-overlay-in fixed inset-0 flex items-stretch justify-center sm:items-center sm:p-6"
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
              className="relative z-[1] flex h-[100dvh] w-full max-w-[480px] flex-col overflow-hidden bg-black sm:h-auto sm:max-h-[min(92dvh,900px)] sm:rounded-2xl sm:shadow-[0_24px_80px_rgba(0,0,0,0.65)] sm:ring-1 sm:ring-white/10"
              onClick={e => e.stopPropagation()}
            >
              {hasBanner ? (
                <>
                  <div className="relative h-[55dvh] min-h-[240px] shrink-0 sm:h-[min(48vh,400px)]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={t.bannerImageUrl!}
                      alt=""
                      className="absolute inset-0 h-full w-full object-cover"
                      loading="eager"
                      decoding="async"
                    />
                    <div
                      className="absolute inset-0 bg-gradient-to-b from-transparent via-black/50 to-black"
                      aria-hidden
                    />
                    <div className="ops-hero-content-in absolute inset-x-0 bottom-0 flex flex-col items-center px-6 pb-6 pt-20 text-center">
                      {copyBlock}
                    </div>
                  </div>
                  {actionBlock}
                </>
              ) : (
                <div
                  className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
                  style={{
                    background:
                      'radial-gradient(ellipse 90% 70% at 50% 45%, rgba(212,175,55,0.08), #000 72%)',
                  }}
                >
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
                    <AlmaBrandMark className="ops-hero-watermark-in text-[200px] opacity-[0.15] sm:text-[220px]" />
                  </div>
                  <div className="ops-hero-content-in relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto overscroll-contain px-6 py-10 text-center">
                    {copyBlock}
                  </div>
                  {actionBlock}
                </div>
              )}
            </div>
          </div>
        )}
      </AnimatePresence>
    </>,
    document.body,
  )
}
