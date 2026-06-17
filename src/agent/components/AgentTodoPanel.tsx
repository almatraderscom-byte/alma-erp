'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { useAgentTodosOptional, type Todo } from './AgentTodoContext'
import {
  isAgentTodoSource,
  isApprovalPendingTodo,
  isInProgressStatus,
  isOwnerTodoSource,
  sortAgentTodosByDutyTime,
  sortOwnerTodos,
  tryOpenOfficeLiveThread,
} from './todo-panel-utils'

export function isFailedStatus(status: string): boolean {
  return status === 'failed' || status === 'cancelled'
}

export function TodoStatusIcon({
  status,
  approvalPending,
  readOnly,
  onClick,
}: {
  status: string
  approvalPending?: boolean
  readOnly?: boolean
  onClick?: () => void
}) {
  const completed = status === 'completed'
  const failed = isFailedStatus(status)
  const running = isInProgressStatus(status)
  const pending = !completed && !failed && !running

  const inner = approvalPending && pending ? (
    <span className="text-[9px] font-bold text-orange-700 leading-none">⏳</span>
  ) : completed ? (
    <motion.svg
      width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="#059669"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
      initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ duration: 0.3 }}
    >
      <motion.path d="M2 5l2.5 2.5L8 3" />
    </motion.svg>
  ) : failed ? (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#dc2626" strokeWidth="2.2" strokeLinecap="round">
      <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
    </svg>
  ) : running ? (
    <motion.svg
      width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="3" strokeLinecap="round"
      animate={{ rotate: 360 }} transition={{ duration: 0.9, repeat: Infinity, ease: 'linear' }}
    >
      <path d="M21 12a9 9 0 11-6.219-8.56" />
    </motion.svg>
  ) : (
    <span className="block h-2 w-2 rounded-full border border-slate-300 bg-transparent" />
  )

  const className = `flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors ${
    approvalPending && pending
      ? 'border-orange-300 bg-orange-50'
      : completed
        ? 'border-emerald-400 bg-emerald-100'
        : failed
          ? 'border-red-300 bg-red-100'
          : running
            ? 'border-amber-400 bg-amber-50'
            : 'border-slate-200 bg-slate-50'
  }`

  if (readOnly) {
    return <div className={className} aria-hidden>{inner}</div>
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={completed ? 'Completed' : failed ? 'Failed' : running ? 'Running' : approvalPending ? 'Approval pending' : 'Pending'}
      className={className}
    >
      {inner}
    </button>
  )
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'bg-red-500',
  high: 'bg-amber-500',
  normal: 'bg-[#E07A5F]',
  low: 'bg-slate-400',
}

const PRIORITY_LABELS: Record<string, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
}

function SectionHeader({
  emoji,
  title,
  count,
  live,
}: {
  emoji: string
  title: string
  count: number
  live?: boolean
}) {
  return (
    <div className="flex items-center gap-2 mb-2.5 mt-1 first:mt-0">
      <span className="text-sm">{emoji}</span>
      <h3 className="text-xs font-bold text-slate-700 flex-1">{title}</h3>
      {live && (
        <span className="text-[9px] font-semibold text-amber-700 bg-amber-50 border border-amber-200/70 px-1.5 py-0.5 rounded-full animate-pulse">
          live
        </span>
      )}
      <span className="text-[10px] font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full tabular-nums">
        {count}
      </span>
    </div>
  )
}

function TodoRow({
  todo,
  readOnly,
  expanded,
  onToggleExpand,
  onToggleComplete,
  onDelete,
  onOpenOffice,
}: {
  todo: Todo
  readOnly?: boolean
  expanded: boolean
  onToggleExpand: () => void
  onToggleComplete?: () => void
  onDelete?: () => void
  onOpenOffice?: () => void
}) {
  const approvalPending = isApprovalPendingTodo(todo)
  const running = isInProgressStatus(todo.status)
  const completed = todo.status === 'completed'
  const hasFeedback = Boolean(todo.description?.trim())
  const showFeedback = hasFeedback && (completed || expanded || approvalPending)

  const rowClass = running
    ? 'bg-amber-50/90 border-amber-200/70 ring-1 ring-amber-200/50 shadow-sm'
    : approvalPending
      ? 'bg-orange-50/40 border-orange-200/60'
      : 'bg-white border-black/[0.06] hover:shadow-sm'

  const handleRowClick = () => {
    if (readOnly && (running || todo.dutyKey)) {
      if (!tryOpenOfficeLiveThread()) {
        toast('🏢 Live office thread — tap the green banner at the top', { duration: 3500 })
      }
      onOpenOffice?.()
      return
    }
    if (hasFeedback && readOnly) onToggleExpand()
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -12 }}
      className={`group flex items-start gap-3 rounded-xl border p-3.5 transition-shadow ${rowClass} ${
        readOnly && (running || hasFeedback) ? 'cursor-pointer' : ''
      }`}
      onClick={readOnly ? handleRowClick : undefined}
      role={readOnly && running ? 'button' : undefined}
    >
      <div className="mt-0.5">
        <TodoStatusIcon
          status={todo.status}
          approvalPending={approvalPending}
          readOnly={readOnly}
          onClick={readOnly ? undefined : onToggleComplete}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2 flex-wrap">
          <p className={`text-sm font-medium leading-snug flex-1 min-w-0 ${
            completed ? 'text-slate-500 line-through decoration-slate-300/80' : 'text-slate-800'
          }`}>
            {todo.title}
          </p>
          {approvalPending && (
            <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-orange-800 bg-orange-100 border border-orange-200/80 px-1.5 py-0.5 rounded-full">
              ⏳ approval
            </span>
          )}
          {running && readOnly && (
            <span className="shrink-0 text-[9px] font-semibold text-amber-800 bg-amber-100/80 px-1.5 py-0.5 rounded-full">
              working…
            </span>
          )}
          {!readOnly && todo.priority !== 'normal' && (
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${PRIORITY_COLORS[todo.priority] ?? 'bg-slate-400'}`} />
          )}
        </div>
        {showFeedback && (
          <p className={`text-xs mt-1.5 leading-relaxed ${
            approvalPending ? 'text-orange-800/90' : 'text-slate-600'
          } ${expanded || running || approvalPending ? '' : 'line-clamp-2'}`}>
            {todo.description}
          </p>
        )}
        {readOnly && hasFeedback && !running && !approvalPending && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleExpand() }}
            className="text-[10px] text-[#E07A5F] font-semibold mt-1 hover:underline"
          >
            {expanded ? 'কম দেখান' : 'ফলাফল দেখুন'}
          </button>
        )}
        {!readOnly && todo.dueDate && (
          <p className="text-[10px] text-slate-400 mt-1">
            Due {new Date(todo.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          </p>
        )}
      </div>
      {!readOnly && onDelete && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 text-slate-400 hover:text-red-500 transition-all shrink-0 mt-0.5 p-1"
          aria-label="Remove task"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M4 4l6 6M10 4l-6 6" />
          </svg>
        </button>
      )}
    </motion.div>
  )
}

function TodoSection({
  emoji,
  title,
  activeTodos,
  completedTodos,
  readOnly,
  live,
  showAdd,
  onAddClick,
  onToggle,
  onDelete,
}: {
  emoji: string
  title: string
  activeTodos: Todo[]
  completedTodos: Todo[]
  readOnly?: boolean
  live?: boolean
  showAdd?: boolean
  onAddClick?: () => void
  onToggle: (todo: Todo) => void
  onDelete: (id: string) => void
}) {
  const [showCompleted, setShowCompleted] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const count = activeTodos.length + completedTodos.length

  if (count === 0 && !showAdd) {
    return (
      <div className="mb-6 last:mb-0">
        <SectionHeader emoji={emoji} title={title} count={0} live={live} />
        <p className="text-xs text-slate-400 pl-1">কিছু নেই</p>
      </div>
    )
  }

  return (
    <div className="mb-6 last:mb-0">
      <div className="flex items-center justify-between gap-2 mb-2">
        <SectionHeader emoji={emoji} title={title} count={count} live={live} />
        {showAdd && onAddClick && (
          <button
            type="button"
            onClick={onAddClick}
            className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#E07A5F]/10 text-[#E07A5F] text-[10px] font-semibold hover:bg-[#E07A5F]/20 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M7 3v8M3 7h8" />
            </svg>
            Add
          </button>
        )}
      </div>

      {activeTodos.length === 0 ? (
        <p className="text-xs text-slate-400 pl-1 mb-2">সব শেষ — completed দেখুন নিচে</p>
      ) : (
        <div className="space-y-2">
          <AnimatePresence>
            {activeTodos.map((todo) => (
              <TodoRow
                key={todo.id}
                todo={todo}
                readOnly={readOnly}
                expanded={expandedIds.has(todo.id)}
                onToggleExpand={() => {
                  setExpandedIds((prev) => {
                    const next = new Set(prev)
                    if (next.has(todo.id)) next.delete(todo.id)
                    else next.add(todo.id)
                    return next
                  })
                }}
                onToggleComplete={() => onToggle(todo)}
                onDelete={() => onDelete(todo.id)}
              />
            ))}
          </AnimatePresence>
        </div>
      )}

      {completedTodos.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowCompleted(!showCompleted)}
            className="flex items-center gap-2 text-xs text-slate-500 font-semibold hover:text-slate-700 transition-colors mb-2"
          >
            <svg
              width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"
              className={`transition-transform ${showCompleted ? 'rotate-90' : ''}`}
            >
              <path d="M4.5 2.5l4 3.5-4 3.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {completedTodos.length} completed
          </button>
          <AnimatePresence>
            {showCompleted && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden space-y-2"
              >
                {completedTodos.map((todo) => (
                  <TodoRow
                    key={todo.id}
                    todo={todo}
                    readOnly={readOnly}
                    expanded={expandedIds.has(todo.id)}
                    onToggleExpand={() => {
                      setExpandedIds((prev) => {
                        const next = new Set(prev)
                        if (next.has(todo.id)) next.delete(todo.id)
                        else next.add(todo.id)
                        return next
                      })
                    }}
                    onToggleComplete={readOnly ? undefined : () => onToggle(todo)}
                    onDelete={readOnly ? undefined : () => onDelete(todo.id)}
                  />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  )
}

export function AgentTodoPanel() {
  const ctx = useAgentTodosOptional()
  const [localTodos, setLocalTodos] = useState<Todo[]>([])
  const [localLoading, setLocalLoading] = useState(!ctx)
  const [localDayShiftActive, setLocalDayShiftActive] = useState(false)

  const [showAdd, setShowAdd] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newPriority, setNewPriority] = useState('normal')
  const [adding, setAdding] = useState(false)

  const localLoad = useCallback(async () => {
    try {
      const [todoRes, shiftRes] = await Promise.all([
        fetch('/api/assistant/todos?includeCompleted=true', { cache: 'no-store' }),
        fetch('/api/assistant/day-shift', { cache: 'no-store' }).catch(() => null),
      ])
      if (todoRes.ok) {
        const data = await todoRes.json() as { todos: Todo[] }
        setLocalTodos(data.todos ?? [])
      }
      if (shiftRes?.ok) {
        const shift = await shiftRes.json() as { active?: boolean }
        setLocalDayShiftActive(Boolean(shift.active))
      }
    } catch { /* ignore */ } finally {
      setLocalLoading(false)
    }
  }, [])

  useEffect(() => { if (!ctx) void localLoad() }, [ctx, localLoad])

  const todos = ctx?.todos ?? localTodos
  const loading = ctx?.loading ?? localLoading
  const dayShiftActive = ctx?.dayShiftActive ?? localDayShiftActive

  const agentTodos = useMemo(
    () => todos.filter((t) => isAgentTodoSource(t.source)),
    [todos],
  )
  const ownerTodos = useMemo(
    () => todos.filter((t) => isOwnerTodoSource(t.source)),
    [todos],
  )

  const agentActive = useMemo(
    () => sortAgentTodosByDutyTime(agentTodos.filter((t) => t.status !== 'completed' && !isFailedStatus(t.status))),
    [agentTodos],
  )
  const agentCompleted = useMemo(
    () => sortAgentTodosByDutyTime(agentTodos.filter((t) => t.status === 'completed')),
    [agentTodos],
  )
  const ownerActive = useMemo(
    () => sortOwnerTodos(ownerTodos.filter((t) => t.status !== 'completed' && !isFailedStatus(t.status))),
    [ownerTodos],
  )
  const ownerCompleted = useMemo(
    () => sortOwnerTodos(ownerTodos.filter((t) => t.status === 'completed')),
    [ownerTodos],
  )

  const cancelledTodos = useMemo(
    () => todos.filter((t) => isFailedStatus(t.status)),
    [todos],
  )

  async function addTodo() {
    if (!newTitle.trim() || adding) return
    setAdding(true)
    try {
      if (ctx) {
        await ctx.add({ title: newTitle.trim(), priority: newPriority })
      } else {
        const res = await fetch('/api/assistant/todos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle.trim(), priority: newPriority, source: 'owner' }),
        })
        if (res.ok) void localLoad()
      }
      setNewTitle('')
      setNewPriority('normal')
      setShowAdd(false)
    } catch { /* ignore */ } finally {
      setAdding(false)
    }
  }

  async function toggleTodo(todo: Todo) {
    if (ctx) return ctx.toggle(todo)
    const newStatus = todo.status === 'completed' ? 'pending' : 'completed'
    try {
      await fetch('/api/assistant/todos', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: todo.id, status: newStatus }),
      })
      void localLoad()
    } catch { /* ignore */ }
  }

  async function deleteTodo(id: string) {
    if (ctx) return ctx.remove(id)
    try {
      await fetch(`/api/assistant/todos?id=${id}`, { method: 'DELETE' })
      void localLoad()
    } catch { /* ignore */ }
  }

  if (loading) {
    return (
      <div className="px-5 py-6 space-y-3">
        <div className="h-4 w-32 bg-slate-200 rounded animate-pulse" />
        <div className="h-12 w-full bg-slate-100 rounded-xl animate-pulse" />
        <div className="h-12 w-full bg-slate-100 rounded-xl animate-pulse" />
      </div>
    )
  }

  const totalActive = agentActive.length + ownerActive.length

  return (
    <div className="px-4 py-5 sm:px-5 sm:py-6">
      <div className="mb-4">
        <h2 className="text-base font-bold text-slate-800">Today&rsquo;s Tasks</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          {totalActive} active
          {agentCompleted.length + ownerCompleted.length > 0
            ? ` · ${agentCompleted.length + ownerCompleted.length} done`
            : ''}
        </p>
      </div>

      <AnimatePresence>
        {showAdd && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden mb-4"
          >
            <div className="bg-white border border-black/[0.06] rounded-2xl p-4 shadow-sm space-y-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">🧑‍💼 আপনার কাজ (Sir)</p>
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="আপনার কাজ লিখুন…"
                className="w-full bg-slate-50 border border-black/[0.06] rounded-xl px-3.5 py-2.5 text-base text-slate-800 placeholder-slate-400 focus:outline-none focus:border-[#E07A5F]/40 focus:ring-1 focus:ring-[#E07A5F]/20 md:text-sm"
                onKeyDown={(e) => { if (e.key === 'Enter') void addTodo() }}
                autoFocus
              />
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">Priority</span>
                {(['low', 'normal', 'high', 'urgent'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setNewPriority(p)}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-colors ${
                      newPriority === p
                        ? 'bg-[#E07A5F] text-white'
                        : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                    }`}
                  >
                    {PRIORITY_LABELS[p]}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  className="flex-1 py-2 rounded-xl border border-black/[0.06] text-xs text-slate-500 font-semibold hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void addTodo()}
                  disabled={!newTitle.trim() || adding}
                  className="flex-1 py-2 rounded-xl bg-[#E07A5F] text-white text-xs font-bold hover:bg-[#C45A3C] transition-colors disabled:opacity-40"
                >
                  {adding ? 'Adding...' : 'Add Task'}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <TodoSection
        emoji="🤖"
        title="এজেন্টের আজকের কাজ"
        activeTodos={agentActive}
        completedTodos={agentCompleted}
        readOnly
        live={dayShiftActive}
        onToggle={toggleTodo}
        onDelete={deleteTodo}
      />

      <TodoSection
        emoji="🧑‍💼"
        title="আপনার কাজ (Sir)"
        activeTodos={ownerActive}
        completedTodos={ownerCompleted}
        showAdd={!showAdd}
        onAddClick={() => setShowAdd(true)}
        onToggle={toggleTodo}
        onDelete={deleteTodo}
      />

      {cancelledTodos.length > 0 && (
        <div className="mt-2 pt-3 border-t border-black/[0.05]">
          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
            {cancelledTodos.length} বাতিল · আজ করা হয়নি
          </p>
          <div className="space-y-1.5 opacity-70">
            {cancelledTodos.slice(0, 8).map((todo) => (
              <p key={todo.id} className="text-xs text-slate-400 line-through px-1">{todo.title}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
