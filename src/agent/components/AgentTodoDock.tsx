'use client'

import { useMemo, type RefObject } from 'react'
import { useAgentTodosOptional } from './AgentTodoContext'
import { AgentTodoPanel } from './AgentTodoPanel'
import { CollapsibleGrid } from './OfficeShiftThreadBlocks'
import {
  filterOwnerTasksToday,
  isAgentTodoSource,
  isFailedStatus,
  isOwnerTodoSource,
} from './todo-panel-utils'

/**
 * Today's Tasks dock — summary header + collapsible body (F-v2).
 * In-flow only (no position:fixed). Intro animates open→closed once per session.
 */
export function AgentTodoDock({ containerRef: _containerRef }: { containerRef: RefObject<HTMLDivElement | null> }) {
  const ctx = useAgentTodosOptional()

  const todos = ctx?.todos ?? []
  const loading = ctx?.loading ?? true
  const dayShiftActive = ctx?.dayShiftActive ?? false
  const panelExpanded = ctx?.panelExpanded ?? false
  const togglePanelExpanded = ctx?.togglePanelExpanded

  const stats = useMemo(() => {
    const agentActive = todos.filter(
      (t) => isAgentTodoSource(t.source) && t.status !== 'completed' && !isFailedStatus(t.status),
    ).length
    const bossActive = filterOwnerTasksToday(todos).filter(
      (t) => isOwnerTodoSource(t.source) && t.status !== 'completed' && !isFailedStatus(t.status),
    ).length
    const done = todos.filter((t) => t.status === 'completed').length
    const active = todos.filter((t) => t.status !== 'completed' && !isFailedStatus(t.status)).length
    return { total: todos.length, active, agentActive, bossActive, done }
  }, [todos])

  if (!ctx) return null
  if (loading || stats.total === 0) return null

  const dateLabel = new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pt-3 pb-1 md:px-6 safe-x">
      <div className="overflow-hidden rounded-2xl border border-black/[0.06] bg-white/90 shadow-sm backdrop-blur-sm">
        <button
          type="button"
          onClick={() => togglePanelExpanded?.()}
          className="flex min-h-[44px] w-full items-center gap-2 px-3 py-2.5 text-left sm:px-4"
          aria-expanded={panelExpanded}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#E07A5F"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
            aria-hidden
          >
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18M9 16l2 2 4-4" />
          </svg>
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[#1a1a2e]">
            {dateLabel}
            <span className="font-normal text-[#94a3b8]">
              {' '}· {stats.total} Tasks · {stats.active} active
              {stats.bossActive > 0 || filterOwnerTasksToday(todos).length > 0
                ? ` · Boss ${stats.bossActive}`
                : ''}
              {' '}· {stats.done} Done
            </span>
          </span>
          {dayShiftActive && (
            <span className="shrink-0 text-[9px] font-semibold text-amber-700 animate-pulse">live</span>
          )}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`shrink-0 text-[#94a3b8] transition-transform duration-[250ms] ease-out ${panelExpanded ? 'rotate-180' : ''}`}
            aria-hidden
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        <CollapsibleGrid open={panelExpanded}>
          <div className="border-t border-black/[0.05] max-h-[min(70dvh,520px)] overflow-y-auto overscroll-y-contain">
            <AgentTodoPanel embedded />
          </div>
        </CollapsibleGrid>
      </div>
    </div>
  )
}

export default AgentTodoDock
