'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAgentTodos } from './AgentTodoContext'
import { AgentTodoPanel } from './AgentTodoPanel'

/**
 * Persistent slim todo bar — Cursor-style.
 * Always visible at the top of every /agent/* page so the owner can see at a glance:
 *   • how many active tasks
 *   • the next task title (top priority)
 *   • progress (completed / total)
 * Tapping expands a drawer with the full todo panel.
 */
export function AgentTodoBar() {
  const { active, completed, loading } = useAgentTodos()
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Hide the bar entirely when there is nothing to show — keeps mobile uncluttered.
  if (loading || (active.length === 0 && completed.length === 0)) return null

  // Show the highest-priority active task as a preview chip.
  const priorityRank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
  const next = [...active].sort(
    (a, b) => (priorityRank[a.priority] ?? 5) - (priorityRank[b.priority] ?? 5),
  )[0]

  const totalToday = active.length + completed.length
  const progressPct = totalToday > 0 ? Math.round((completed.length / totalToday) * 100) : 0

  return (
    <>
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        aria-label="Tasks"
        className="group flex w-full items-center gap-3 border-b border-black/[0.06] bg-white/85 px-3 py-2 text-left transition-colors hover:bg-white md:px-5"
      >
        {/* Progress ring */}
        <span className="relative flex h-7 w-7 shrink-0 items-center justify-center">
          <svg width="28" height="28" viewBox="0 0 28 28" className="rotate-[-90deg]">
            <circle cx="14" cy="14" r="11" fill="none" stroke="rgba(0,0,0,0.06)" strokeWidth="2.5" />
            <motion.circle
              cx="14"
              cy="14"
              r="11"
              fill="none"
              stroke="#E07A5F"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 11}
              initial={false}
              animate={{ strokeDashoffset: 2 * Math.PI * 11 * (1 - progressPct / 100) }}
              transition={{ duration: 0.4 }}
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-[#1a1a2e]">
            {active.length}
          </span>
        </span>

        <span className="flex-1 min-w-0">
          <span className="block truncate text-[13px] font-medium text-[#1a1a2e]">
            {next ? next.title : 'All caught up'}
          </span>
          <span className="block truncate text-[10px] text-[#64748b]">
            {active.length} active{completed.length > 0 ? ` · ${completed.length} done today` : ''} · tap to view
          </span>
        </span>

        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-[#94a3b8] transition-transform group-hover:translate-x-0.5"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>

      <AnimatePresence>
        {drawerOpen && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
              onClick={() => setDrawerOpen(false)}
            />
            {/* Drawer — bottom sheet on mobile, right sheet on desktop */}
            <motion.div
              initial={{ y: '100%', opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: '100%', opacity: 0 }}
              transition={{ type: 'spring', damping: 28, stiffness: 280 }}
              className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-3xl border-t border-black/[0.06] bg-[#FAF9F6] shadow-2xl md:inset-y-0 md:right-0 md:left-auto md:bottom-auto md:max-h-none md:w-[420px] md:rounded-l-3xl md:rounded-tr-none md:border-l md:border-t-0"
            >
              <div className="sticky top-0 z-10 flex items-center justify-between border-b border-black/[0.06] bg-[#FAF9F6]/95 px-5 py-3 backdrop-blur-md">
                <div>
                  <h2 className="text-base font-bold text-slate-800">Tasks</h2>
                  <p className="text-[11px] text-slate-500">
                    {active.length} active{completed.length > 0 ? ` · ${completed.length} done` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close"
                  className="flex h-9 w-9 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-black/[0.05] hover:text-slate-700"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <AgentTodoPanel />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  )
}

export default AgentTodoBar
