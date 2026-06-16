'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAgentTodosOptional } from './AgentTodoContext'
import { AgentTodoPanel } from './AgentTodoPanel'

/**
 * Single, scroll-aware todo dock — the ONLY todo component in the agent chat.
 *
 * Behavior (Cursor-style):
 *   • At the top of the conversation  → full "Today's Tasks" card (in-flow, scrolls naturally)
 *   • Once scrolled past it / chatting → a compact sticky header pins to the top and stays
 *     visible for the whole conversation; tapping it expands the full list as a dropdown.
 *
 * Lives as the first child of the chat scroll container so `position: sticky` pins to the
 * conversation viewport.
 */
export function AgentTodoDock({ containerRef }: { containerRef: RefObject<HTMLDivElement | null> }) {
  const ctx = useAgentTodosOptional()
  const [scrolled, setScrolled] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Toggle compact mode once the full card scrolls out of the viewport.
  useEffect(() => {
    const root = containerRef.current
    const sentinel = sentinelRef.current
    if (!root || !sentinel) return
    const io = new IntersectionObserver(
      ([entry]) => setScrolled(!entry.isIntersecting),
      { root, threshold: 0, rootMargin: '0px' },
    )
    io.observe(sentinel)
    return () => io.disconnect()
  }, [containerRef])

  // Collapse the dropdown whenever we return to full mode.
  useEffect(() => {
    if (!scrolled) setExpanded(false)
  }, [scrolled])

  if (!ctx) return null
  const { active, completed, loading } = ctx
  const total = active.length + completed.length
  if (loading || total === 0) return null

  const dateLabel = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

  return (
    <>
      {/* ── Compact sticky header (visible when scrolled) ── */}
      <div className="pointer-events-none sticky top-0 z-30">
        <AnimatePresence>
          {scrolled && (
            <motion.div
              initial={{ y: -48, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -48, opacity: 0 }}
              transition={{ type: 'spring', damping: 26, stiffness: 320 }}
              className="pointer-events-auto border-b border-black/[0.06] bg-white/80 backdrop-blur-xl"
              style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
            >
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left md:px-6"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#E07A5F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <path d="M16 2v4M8 2v4M3 10h18M9 16l2 2 4-4" />
                </svg>
                <span className="text-[12px] font-semibold text-[#1a1a2e]">{dateLabel}</span>
                <span className="text-[11px] text-[#94a3b8]">·</span>
                <span className="flex items-center gap-2 text-[11px] font-medium">
                  <span className="text-[#1a1a2e]">{total} Tasks</span>
                  <span className="inline-flex items-center gap-1 text-emerald-600">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    {completed.length} Done
                  </span>
                  <span className="inline-flex items-center gap-1 text-[#E07A5F]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#E07A5F]" />
                    {active.length} Pending
                  </span>
                </span>
                <svg
                  width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                  className={`ml-auto shrink-0 text-[#94a3b8] transition-transform ${expanded ? 'rotate-180' : ''}`}
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>

              {/* Expand dropdown — full list as overlay */}
              <AnimatePresence>
                {expanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden border-t border-black/[0.05]"
                  >
                    <div className="mx-auto max-h-[55vh] max-w-2xl overflow-y-auto">
                      <AgentTodoPanel />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Full card (in-flow at the top, scrolls away naturally) ── */}
      <div className="mx-auto w-full max-w-2xl px-4 pt-3 md:px-6">
        <div className="overflow-hidden rounded-2xl border border-black/[0.06] bg-white/85 shadow-sm backdrop-blur-sm">
          <AgentTodoPanel />
        </div>
      </div>
      <div ref={sentinelRef} aria-hidden className="h-px w-full" />
    </>
  )
}

export default AgentTodoDock
