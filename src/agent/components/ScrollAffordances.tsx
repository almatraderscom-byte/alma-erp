'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface ScrollAffordancesProps {
  /**
   * The scroll container to track. If undefined, uses the window/document scroll.
   * Pass either a real ref-object OR a plain object with `.current` (e.g. from
   * useRef) — both work.
   */
  containerRef?: RefObject<HTMLElement | null>
  /** px from top before showing scroll-to-top */
  topThreshold?: number
  /** px from bottom before showing scroll-to-bottom */
  bottomThreshold?: number
  /**
   * Lifts the floating gutter above mobile bottom-nav (4rem) by default.
   * Caller can override for pages without the bottom nav.
   */
  bottomOffsetClass?: string
}

/**
 * Floating scroll affordances rendered fixed in the bottom-right gutter:
 *  - "Top" button when scrolled past `topThreshold`
 *  - "Bottom" button when more than `bottomThreshold` from the bottom
 * Buttons fade in/out, never overlap content (fixed-positioned in gutter),
 * and respect iOS safe-area-inset-bottom + the agent bottom-nav.
 */
export function ScrollAffordances({
  containerRef,
  topThreshold = 320,
  bottomThreshold = 240,
  bottomOffsetClass = 'bottom-[calc(4.5rem+env(safe-area-inset-bottom))] md:bottom-6',
}: ScrollAffordancesProps) {
  const [showTop, setShowTop] = useState(false)
  const [showBottom, setShowBottom] = useState(false)
  // Throttle scroll work to one per animation frame.
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const target: HTMLElement | (Window & typeof globalThis) =
      containerRef?.current ?? window
    const isWindow = target === window

    const compute = () => {
      rafRef.current = null
      let scrollTop: number
      let scrollHeight: number
      let clientHeight: number
      if (isWindow) {
        scrollTop = window.scrollY
        scrollHeight = document.documentElement.scrollHeight
        clientHeight = window.innerHeight
      } else {
        const el = target as HTMLElement
        scrollTop = el.scrollTop
        scrollHeight = el.scrollHeight
        clientHeight = el.clientHeight
      }
      setShowTop(scrollTop > topThreshold)
      setShowBottom(scrollHeight - scrollTop - clientHeight > bottomThreshold)
    }

    const onScroll = () => {
      if (rafRef.current != null) return
      rafRef.current = requestAnimationFrame(compute)
    }

    compute()
    target.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      target.removeEventListener('scroll', onScroll)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [containerRef, topThreshold, bottomThreshold])

  function scrollToTop() {
    const target = containerRef?.current
    if (target) target.scrollTo({ top: 0, behavior: 'smooth' })
    else window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function scrollToBottom() {
    const target = containerRef?.current
    if (target) target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' })
    else window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })
  }

  if (!showTop && !showBottom) return null

  return (
    <div
      className={`pointer-events-none fixed right-3 z-40 flex flex-col gap-2 md:right-5 ${bottomOffsetClass}`}
      aria-hidden={!showTop && !showBottom}
    >
      <AnimatePresence>
        {showTop && (
          <motion.button
            key="top"
            type="button"
            initial={{ opacity: 0, scale: 0.6, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.6, y: 8 }}
            transition={{ type: 'spring', stiffness: 520, damping: 30, mass: 0.7 }}
            onClick={scrollToTop}
            aria-label="উপরে যান"
            className="alma-frost pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full text-gray-500 transition-colors hover:text-[#E07A5F] active:scale-90 md:h-10 md:w-10"
          >
            <svg className="h-[13px] w-[13px] md:h-[14px] md:w-[14px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </motion.button>
        )}
        {showBottom && (
          <motion.button
            key="bottom"
            type="button"
            initial={{ opacity: 0, scale: 0.6, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.6, y: -8 }}
            transition={{ type: 'spring', stiffness: 520, damping: 30, mass: 0.7 }}
            onClick={scrollToBottom}
            aria-label="নিচে যান"
            className="alma-frost pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full text-gray-500 transition-colors hover:text-[#E07A5F] active:scale-90 md:h-10 md:w-10"
          >
            <svg className="h-[13px] w-[13px] md:h-[14px] md:w-[14px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M19 12l-7 7-7-7" />
            </svg>
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}

export default ScrollAffordances
