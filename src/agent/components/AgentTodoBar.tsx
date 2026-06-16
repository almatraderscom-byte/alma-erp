'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useAgentTodos, type Todo } from './AgentTodoContext'
import { AgentTodoPanel } from './AgentTodoPanel'

/** Control surfaces (monitor / costs) own their full vertical space — the todo bar
 *  overlaps their sticky headers there, so it is suppressed on those routes. */
const HIDE_ON = ['/agent/staff-monitor', '/agent/costs']

const COLLAPSE_KEY = 'alma.agent.todobar.collapsed'

const PRIORITY_DOT: Record<string, string> = {
  urgent: 'bg-red-500',
  high: 'bg-amber-500',
  normal: 'bg-[#E07A5F]',
  low: 'bg-slate-400',
}

/**
 * Cursor-style persistent task list.
 *
 * Always visible at the top of /agent chat. Shows today's tasks inline with live
 * status: the agent ticks them off in place (green check + strikethrough animation)
 * as it completes work — no need to open a drawer to see progress. The drawer is
 * only for full management (add / delete / browse all completed).
 */
export function AgentTodoBar() {
  const { active, completed, loading, toggle } = useAgentTodos()
  const [collapsed, setCollapsed] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const pathname = usePathname()

  // Restore collapse preference.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1')
    } catch {
      /* ignore */
    }
  }, [])

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }

  // Suppress on control surfaces (monitor/costs) to avoid overlapping their sticky headers.
  if (pathname && HIDE_ON.some((p) => pathname.startsWith(p))) return null

  // Hide entirely when there is nothing to show — keeps mobile uncluttered.
  if (loading || (active.length === 0 && completed.length === 0)) return null

  const totalToday = active.length + completed.length
  const progressPct = totalToday > 0 ? Math.round((completed.length / totalToday) * 100) : 0

  // Show active tasks first, then the most recent completed ones (so the owner
  // sees what just got ticked off without expanding the full drawer).
  const priorityRank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
  const sortedActive = [...active].sort(
    (a, b) => (priorityRank[a.priority] ?? 5) - (priorityRank[b.priority] ?? 5),
  )
  const recentDone = [...completed]
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
    .slice(0, 3)

  return (
    <>
      <div className="border-b border-black/[0.06] bg-white/85 backdrop-blur-sm">
        {/* Header row */}
        <div className="flex items-center gap-3 px-3 py-2 md:px-5">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand tasks' : 'Collapse tasks'}
            className="group flex flex-1 items-center gap-3 text-left"
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
              <span className="block text-[13px] font-semibold text-[#1a1a2e]">
                {active.length > 0 ? "Today's tasks" : 'All caught up'}
              </span>
              <span className="block truncate text-[10px] text-[#64748b]">
                {active.length} active{completed.length > 0 ? ` · ${completed.length} done` : ''}
              </span>
            </span>

            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`shrink-0 text-[#94a3b8] transition-transform ${collapsed ? '' : 'rotate-180'}`}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>

          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Manage tasks"
            className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-semibold text-[#E07A5F] transition-colors hover:bg-[#E07A5F]/10"
          >
            Manage
          </button>
        </div>

        {/* Inline task list */}
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="max-h-[40vh] overflow-y-auto px-3 pb-2 md:px-5">
                <div className="space-y-1">
                  <AnimatePresence initial={false}>
                    {sortedActive.map((todo) => (
                      <TaskRow key={todo.id} todo={todo} onToggle={() => void toggle(todo)} />
                    ))}
                    {recentDone.map((todo) => (
                      <TaskRow key={todo.id} todo={todo} onToggle={() => void toggle(todo)} done />
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Full management drawer */}
      <AnimatePresence>
        {drawerOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
              onClick={() => setDrawerOpen(false)}
            />
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

/** A single inline task row with a live, animated completion checkmark. */
function TaskRow({ todo, onToggle, done }: { todo: Todo; onToggle: () => void; done?: boolean }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -16 }}
      transition={{ duration: 0.2 }}
      className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-black/[0.025]"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-label={done ? 'Mark incomplete' : 'Mark complete'}
        className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md border-2 transition-colors ${
          done
            ? 'border-emerald-400 bg-emerald-100'
            : todo.status === 'in_progress'
              ? 'border-[#E07A5F] bg-[#E07A5F]/10'
              : 'border-slate-300 hover:border-[#E07A5F]'
        }`}
      >
        {done ? (
          <motion.svg
            width="11"
            height="11"
            viewBox="0 0 10 10"
            fill="none"
            stroke="#059669"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 0.3 }}
          >
            <motion.path d="M2 5l2.5 2.5L8 3" />
          </motion.svg>
        ) : todo.status === 'in_progress' ? (
          <motion.span
            className="h-2 w-2 rounded-sm bg-[#E07A5F]"
            animate={{ opacity: [1, 0.4, 1] }}
            transition={{ duration: 1.2, repeat: Infinity }}
          />
        ) : null}
      </button>

      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-[12.5px] leading-snug transition-colors ${
            done ? 'text-slate-400 line-through' : 'font-medium text-[#1a1a2e]'
          }`}
        >
          {todo.title}
        </span>
      </span>

      {!done && todo.priority !== 'normal' && (
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[todo.priority] ?? 'bg-slate-400'}`} />
      )}
      {todo.source === 'agent' && !done && (
        <span className="shrink-0 rounded bg-[#E07A5F]/10 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-[#E07A5F]">
          Agent
        </span>
      )}
    </motion.div>
  )
}

export default AgentTodoBar
