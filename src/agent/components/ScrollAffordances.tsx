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
  /**
   * Claude-style placement for the scroll-to-bottom button: a prominent circular
   * down-arrow CENTERED horizontally just above the composer (instead of tucked
   * in the right gutter where the owner couldn't find it). The scroll-to-top
   * button stays in the right gutter. Defaults to true.
   */
  centerBottom?: boolean
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
  centerBottom = true,
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

    // The scroll position is not the only thing that changes the distance-to-
    // bottom: when a big reply streams in (or a long message arrives) the content
    // grows WITHOUT a scroll event, so the scroll-to-bottom button would never
    // appear. Observe content size + DOM mutations and recompute then too. This
    // is what fixes "sms boro hole nicher dike jawa button nai".
    let ro: ResizeObserver | null = null
    let mo: MutationObserver | null = null
    if (!isWindow) {
      const el = target as HTMLElement
      ro = new ResizeObserver(onScroll)
      ro.observe(el)
      if (el.firstElementChild) ro.observe(el.firstElementChild)
      mo = new MutationObserver(onScroll)
      mo.observe(el, { childList: true, subtree: true, characterData: true })
    }

    return () => {
      target.removeEventListener('scroll', onScroll)
      ro?.disconnect()
      mo?.disconnect()
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

  // Down-arrow glyph reused by both placements.
  const downArrow = (
    <svg className="h-[15px] w-[15px] md:h-4 md:w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </svg>
  )

  return (
    <>
      {/* Scroll-to-TOP stays in the right gutter. */}
      <div
        className={`pointer-events-none fixed right-3 z-40 flex flex-col gap-2 md:right-5 ${bottomOffsetClass}`}
        aria-hidden={!showTop}
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
              className="alma-frost pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full text-muted transition-colors hover:text-[#E07A5F] active:scale-90 md:h-10 md:w-10"
            >
              <svg className="h-[13px] w-[13px] md:h-[14px] md:w-[14px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </motion.button>
          )}
          {/* When NOT centered, the bottom button shares this gutter (legacy). */}
          {!centerBottom && showBottom && (
            <motion.button
              key="bottom-gutter"
              type="button"
              initial={{ opacity: 0, scale: 0.6, y: -8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.6, y: -8 }}
              transition={{ type: 'spring', stiffness: 520, damping: 30, mass: 0.7 }}
              onClick={scrollToBottom}
              aria-label="নিচে যান"
              className="alma-frost pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full text-muted transition-colors hover:text-[#E07A5F] active:scale-90 md:h-10 md:w-10"
            >
              {downArrow}
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* Scroll-to-BOTTOM, Claude-style: prominent circular button CENTERED just
          above the composer so it's always findable. */}
      {centerBottom && (
        <div
          className={`pointer-events-none fixed left-1/2 z-40 -translate-x-1/2 ${bottomOffsetClass}`}
          aria-hidden={!showBottom}
        >
          <AnimatePresence>
            {showBottom && (
              <motion.button
                key="bottom-center"
                type="button"
                initial={{ opacity: 0, scale: 0.6, y: -8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.6, y: -8 }}
                transition={{ type: 'spring', stiffness: 520, damping: 30, mass: 0.7 }}
                onClick={scrollToBottom}
                aria-label="নিচে যান"
                // Transparent glass (owner asked for transparent): see-through
                // tint + blur instead of the opaque frost, with a faint ring so
                // it stays findable over both light and dark message bubbles.
                className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-muted ring-1 ring-white/20 backdrop-blur-md transition-colors hover:bg-white/20 hover:text-[#E07A5F] active:scale-90"
              >
                {downArrow}
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      )}
    </>
  )
}

export default ScrollAffordances
