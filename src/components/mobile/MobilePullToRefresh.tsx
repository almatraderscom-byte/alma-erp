'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useMobileRefresh } from '@/contexts/MobileRefreshContext'
import {
  MOBILE_REFRESH_MAX_PULL_PX,
  MOBILE_REFRESH_PULL_THRESHOLD_PX,
  mobileRefreshHaptic,
} from '@/lib/mobile-refresh'
import { cn } from '@/lib/utils'

type PullPhase = 'idle' | 'pulling' | 'ready' | 'refreshing' | 'success'

/** Visual + gesture layer — parent `<main>` must pass `scrollRef`. */
export function MobilePullToRefresh({
  children,
  scrollRef,
}: {
  children: ReactNode
  scrollRef: React.RefObject<HTMLElement | null>
}) {
  const { refresh, refreshing, isMobileEnabled, registerScrollElement } = useMobileRefresh()
  const [pullPx, setPullPx] = useState(0)
  const [phase, setPhase] = useState<PullPhase>('idle')

  const startY = useRef(0)
  const pulling = useRef(false)
  const pullPxRef = useRef(0)

  useEffect(() => {
    registerScrollElement(scrollRef.current)
    return () => registerScrollElement(null)
  }, [registerScrollElement, scrollRef])

  const resetPull = useCallback(() => {
    pulling.current = false
    pullPxRef.current = 0
    setPullPx(0)
    if (!refreshing) setPhase('idle')
  }, [refreshing])

  const runRefresh = useCallback(async () => {
    setPhase('refreshing')
    const hold = MOBILE_REFRESH_PULL_THRESHOLD_PX * 0.85
    pullPxRef.current = hold
    setPullPx(hold)
    const result = await refresh({ silent: true })
    if (result.ok) {
      setPhase('success')
      window.setTimeout(() => {
        setPhase('idle')
        pullPxRef.current = 0
        setPullPx(0)
      }, 420)
    } else if (result.reason === 'throttled' || result.reason === 'busy') {
      resetPull()
    } else {
      setPhase('idle')
      pullPxRef.current = 0
      setPullPx(0)
    }
  }, [refresh, resetPull])

  useEffect(() => {
    if (refreshing) {
      setPhase('refreshing')
      const hold = MOBILE_REFRESH_PULL_THRESHOLD_PX * 0.85
      pullPxRef.current = hold
      setPullPx(hold)
    }
  }, [refreshing])

  useEffect(() => {
    if (!isMobileEnabled) return
    const el = scrollRef.current
    if (!el) return

    const onTouchStart = (e: TouchEvent) => {
      if (refreshing) return
      if (el.scrollTop > 2) return
      const touch = e.touches[0]
      if (!touch) return
      startY.current = touch.clientY
      pulling.current = true
    }

    const onTouchMove = (e: TouchEvent) => {
      if (!pulling.current || refreshing) return
      if (el.scrollTop > 2) {
        resetPull()
        return
      }
      const touch = e.touches[0]
      if (!touch) return
      const delta = touch.clientY - startY.current
      if (delta <= 0) {
        pullPxRef.current = 0
        setPullPx(0)
        setPhase('idle')
        return
      }
      e.preventDefault()
      const damped = Math.min(MOBILE_REFRESH_MAX_PULL_PX, delta * 0.52)
      pullPxRef.current = damped
      setPullPx(damped)
      setPhase(damped >= MOBILE_REFRESH_PULL_THRESHOLD_PX ? 'ready' : 'pulling')
    }

    const onTouchEnd = () => {
      if (!pulling.current) return
      pulling.current = false
      if (pullPxRef.current >= MOBILE_REFRESH_PULL_THRESHOLD_PX && !refreshing) {
        mobileRefreshHaptic('pull')
        void runRefresh()
        return
      }
      resetPull()
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })

    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [isMobileEnabled, refreshing, resetPull, runRefresh, scrollRef])

  const indicatorVisible = isMobileEnabled && (pullPx > 4 || phase === 'refreshing' || phase === 'success')
  const progress = Math.min(1, pullPx / MOBILE_REFRESH_PULL_THRESHOLD_PX)
  const translateY = pullPx > 0 ? pullPx * 0.35 : 0

  return (
    <>
      <div
        aria-hidden={!indicatorVisible}
        className={cn(
          'pointer-events-none fixed left-0 right-0 z-[60] flex flex-col items-center justify-end transition-opacity duration-200 md:hidden',
          indicatorVisible ? 'opacity-100' : 'opacity-0',
        )}
        style={{
          top: 0,
          height: Math.max(56, pullPx + 8),
        }}
      >
        <div className="flex flex-col items-center gap-1 pb-2 pt-[max(0.25rem,env(safe-area-inset-top))]">
          <SpinnerRing spinning={phase === 'refreshing'} progress={phase === 'refreshing' ? 1 : progress} />
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gold-lt/90">
            {phase === 'refreshing'
              ? 'Refreshing…'
              : phase === 'success'
                ? 'Updated'
                : phase === 'ready'
                  ? 'Release to refresh'
                  : 'Pull to refresh'}
          </p>
        </div>
      </div>

      <div
        className="min-h-full"
        style={{
          transform: translateY > 0 ? `translate3d(0, ${translateY}px, 0)` : undefined,
          transition: pulling.current ? 'none' : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {children}
      </div>
    </>
  )
}

function SpinnerRing({ spinning, progress }: { spinning: boolean; progress: number }) {
  const deg = Math.round(progress * 300)
  return (
    <div
      className={cn(
        'relative h-7 w-7 rounded-full border-2 border-gold-dim/25',
        spinning && 'animate-spin border-t-gold',
      )}
      style={
        !spinning
          ? { transform: `rotate(${deg}deg)`, borderTopColor: 'rgba(201, 168, 76, 0.85)' }
          : undefined
      }
    />
  )
}
