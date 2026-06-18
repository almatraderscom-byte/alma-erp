'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface ScrollAffordancesProps {
  /**
   * The scroll container to track. If undefined, uses the window/document scroll.
   * Pass either a real ref-object OR a plain object with `.current`.
   */
  containerRef?: RefObject<HTMLElement | null>
  /** px from bottom before showing the scroll-to-bottom pill */
  bottomThreshold?: number
  /**
   * Lifts the floating pill above the mobile bottom-nav (4rem) by default.
   * Caller can override for pages without the bottom nav.
   */
  bottomOffsetClass?: string
}

/**
 * Claude-style scroll-to-bottom pill: a single small, frosted ↓ button in the
 * bottom-right gutter that fades in only when the user has scrolled up, and
 * glides to the latest message on tap. Hidden when already at the bottom.
 */
export function ScrollAffordances({
  containerRef,
  bottomThreshold = 120,
  bottomOffsetClass = 'bottom-[calc(4.5rem+env(safe-area-inset-bottom))] md:bottom-6',
}: ScrollAffordancesProps) {
  const [showBottom, setShowBottom] = useState(false)
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
  }, [containerRef, bottomThreshold])

  function scrollToBottom() {
    const target = containerRef?.current
    if (target) target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' })
    else window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })
  }

  return (
    <div
      className={`pointer-events-none fixed right-3 z-40 flex flex-col items-end md:right-5 ${bottomOffsetClass}`}
      aria-hidden={!showBottom}
    >
      <AnimatePresence>
        {showBottom && (
          <motion.button
            key="bottom"
            type="button"
            initial={{ opacity: 0, scale: 0.8, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 4 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            onClick={scrollToBottom}
            aria-label="নিচে যান"
            className="alma-frost pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full text-[#64748b] transition-colors hover:text-[#E07A5F] active:scale-95"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M19 12l-7 7-7-7" />
            </svg>
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}

export default ScrollAffordances
