'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { useAgentTodosOptional, type Todo } from './AgentTodoContext'
import { brandTodo } from './todo-brand-tokens'
import {
  filterOwnerTasksToday,
  isAgentTodoSource,
  isApprovalPendingTodo,
  isFailedStatus,
  isInProgressStatus,
  isOwnerTodoSource,
  isRejectedStatus,
  ownerDueDateIso,
  sortAgentTodosByDutyTime,
  sortOwnerTodos,
  tryOpenOfficeLiveThread,
} from './todo-panel-utils'

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
  const rejected = isRejectedStatus(status)
  const cancelled = status === 'cancelled' || status === 'failed'
  const failed = cancelled || rejected
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
  ) : rejected ? (
    <span className="text-[8px] font-bold text-red-700 leading-none">✕</span>
  ) : cancelled ? (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#94a3b8" strokeWidth="2.2" strokeLinecap="round">
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
        : rejected
          ? 'border-red-300 bg-red-50'
          : cancelled
            ? 'border-slate-300 bg-slate-100'
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
      aria-label={completed ? 'Completed' : rejected ? 'Rejected' : cancelled ? 'Cancelled' : running ? 'Running' : approvalPending ? 'Approval pending' : 'Pending'}
      className={className}
    >
      {inner}
    </button>
  )
}

const PRIORITY_LABELS: Record<string, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
}

function TodoRow({
  todo,
  readOnly,
  compact,
  expanded,
  onToggleExpand,
  onToggleComplete,
  onDelete,
}: {
  todo: Todo
  readOnly?: boolean
  compact?: boolean
  expanded: boolean
  onToggleExpand: () => void
  onToggleComplete?: () => void
  onDelete?: () => void
}) {
  const approvalPending = isApprovalPendingTodo(todo)
  const running = isInProgressStatus(todo.status)
  const completed = todo.status === 'completed'
  const rejected = isRejectedStatus(todo.status)
  const cancelled = todo.status === 'cancelled' || todo.status === 'failed'
  const hasFeedback = Boolean(todo.description?.trim())
  const showFeedback = hasFeedback && (completed || expanded || approvalPending)

  const rowClass = running
    ? 'bg-amber-50/90 border-amber-200/70 ring-1 ring-amber-200/50'
    : approvalPending
      ? 'bg-orange-50/40 border-orange-200/60'
      : rejected
        ? 'bg-red-50/30 border-red-200/50 opacity-80'
        : cancelled
          ? 'bg-slate-50/80 border-slate-200/60 opacity-70'
          : 'bg-white border-black/[0.06] hover:shadow-sm'

  const handleRowClick = () => {
    if (readOnly && (running || todo.dutyKey)) {
      if (!tryOpenOfficeLiveThread()) {
        toast('🏢 Live office thread — tap the green banner at the top', { duration: 3500 })
      }
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
      className={`group flex items-start gap-2.5 rounded-xl border transition-shadow ${
        compact ? 'p-2' : 'p-3.5'
      } ${rowClass} ${readOnly && (running || hasFeedback) ? 'cursor-pointer' : ''}`}
      onClick={readOnly ? handleRowClick : undefined}
    >
      <div className={compact ? 'mt-0' : 'mt-0.5'}>
        <TodoStatusIcon
          status={todo.status}
          approvalPending={approvalPending}
          readOnly={readOnly}
          onClick={readOnly ? undefined : onToggleComplete}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2 flex-wrap">
          <p className={`font-medium leading-snug flex-1 min-w-0 ${
            compact ? 'text-xs truncate' : 'text-sm'
          } ${
            completed ? 'text-slate-500 line-through decoration-slate-300/80' : 'text-slate-800'
          } ${cancelled || rejected ? 'line-through decoration-slate-300/70 text-slate-500' : ''}`}>
            {todo.title}
          </p>
          {approvalPending && (
            <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-orange-800 bg-orange-100 border border-orange-200/80 px-1.5 py-0.5 rounded-full">
              pending
            </span>
          )}
          {rejected && (
            <span className="shrink-0 text-[9px] font-semibold text-red-800 bg-red-100 border border-red-200/80 px-1.5 py-0.5 rounded-full">
              Reject by Boss
            </span>
          )}
          {running && readOnly && (
            <span className="shrink-0 text-[9px] font-semibold text-amber-800 bg-amber-100/80 px-1.5 py-0.5 rounded-full">
              working…
            </span>
          )}
        </div>
        {showFeedback && !compact && (
          <p className={`text-xs mt-1.5 leading-relaxed ${
            approvalPending ? 'text-orange-800/90' : 'text-slate-600'
          } ${expanded || running || approvalPending ? '' : 'line-clamp-2'}`}>
            {todo.description}
          </p>
        )}
        {readOnly && hasFeedback && !running && !approvalPending && !compact && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleExpand() }}
            className="text-[10px] text-[#E07A5F] font-semibold mt-1 hover:underline"
          >
            {expanded ? 'কম দেখান' : 'ফলাফল দেখুন'}
          </button>
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

function UnifiedTodoList({
  todos,
  readOnly,
  compact,
  onToggle,
  onDelete,
}: {
  todos: Todo[]
  readOnly?: boolean
  compact?: boolean
  onToggle: (todo: Todo) => void
  onDelete: (id: string) => void
}) {
  const [showCompleted, setShowCompleted] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  const openList = useMemo(
    () => todos.filter((t) => t.status !== 'completed'),
    [todos],
  )
  const completedList = useMemo(
    () => todos.filter((t) => t.status === 'completed'),
    [todos],
  )

  if (todos.length === 0) {
    return <p className="text-xs text-slate-400 pl-0.5">কিছু নেই</p>
  }

  return (
    <>
      <div className={compact ? 'space-y-1.5' : 'space-y-2'}>
        <AnimatePresence>
          {openList.map((todo) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              readOnly={readOnly}
              compact={compact}
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

      {completedList.length > 0 && (
        <div className={compact ? 'mt-2' : 'mt-3'}>
          <button
            type="button"
            onClick={() => setShowCompleted(!showCompleted)}
            className="flex items-center gap-2 text-[10px] text-slate-500 font-semibold hover:text-slate-700 transition-colors mb-1.5"
          >
            <svg
              width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"
              className={`transition-transform ${showCompleted ? 'rotate-90' : ''}`}
            >
              <path d="M4.5 2.5l4 3.5-4 3.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {completedList.length} done
          </button>
          <AnimatePresence>
            {showCompleted && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className={`overflow-hidden ${compact ? 'space-y-1.5' : 'space-y-2'}`}
              >
                {completedList.map((todo) => (
                  <TodoRow
                    key={todo.id}
                    todo={todo}
                    readOnly={readOnly}
                    compact={compact}
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
    </>
  )
}

function AgentCompactCard({
  todos,
  dayShiftActive,
  onToggle,
  onDelete,
}: {
  todos: Todo[]
  dayShiftActive: boolean
  onToggle: (todo: Todo) => void
  onDelete: (id: string) => void
}) {
  const done = todos.filter((t) => t.status === 'completed').length
  const total = todos.length

  return (
    <div className={`${brandTodo.agentCompact} p-3 h-full flex flex-col`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs">🤖</span>
        <h3 className="text-[11px] font-bold text-slate-700 flex-1">এজেন্টের কাজ</h3>
        {dayShiftActive && (
          <span className="text-[8px] font-semibold text-amber-700 bg-amber-50 border border-amber-200/70 px-1.5 py-0.5 rounded-full animate-pulse">
            live
          </span>
        )}
        <span className="text-[10px] font-bold text-slate-500 tabular-nums">
          {done}/{total}
        </span>
      </div>
      <div className="flex-1 min-h-0">
        <UnifiedTodoList todos={todos} readOnly compact onToggle={onToggle} onDelete={onDelete} />
      </div>
      <button
        type="button"
        onClick={() => {
          if (!tryOpenOfficeLiveThread()) {
            toast('🏢 অফিস chat — উপরে সবুজ বanner ট্যাপ করুন', { duration: 3500 })
          }
        }}
        className="mt-2.5 w-full text-left text-[10px] font-medium text-slate-500 hover:text-[#E07A5F] transition-colors"
      >
        🏢 অফিস chat-এ live
      </button>
    </div>
  )
}

function BossTodoFrame({
  todos,
  showAddForm,
  onShowAdd,
  onAdd,
  onToggle,
  onDelete,
  adding,
  newTitle,
  setNewTitle,
  newPriority,
  setNewPriority,
}: {
  todos: Todo[]
  showAddForm: boolean
  onShowAdd: () => void
  onAdd: () => void
  onToggle: (todo: Todo) => void
  onDelete: (id: string) => void
  adding: boolean
  newTitle: string
  setNewTitle: (v: string) => void
  newPriority: string
  setNewPriority: (v: string) => void
}) {
  const firstActive = todos.find(
    (t) => t.status !== 'completed' && !isFailedStatus(t.status),
  )

  return (
    <div className={`${brandTodo.bossFrame} p-3.5 sm:p-4 h-full flex flex-col`}>
      <div className="flex items-center gap-2 mb-2.5">
        <span className="text-sm">🧑‍💼</span>
        <h3 className={`text-xs font-bold flex-1 ${brandTodo.coralDark}`}>
          Boss-এর আজকের কাজ
        </h3>
        {!showAddForm && (
          <button
            type="button"
            onClick={onShowAdd}
            className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold transition-colors ${brandTodo.coralBg} ${brandTodo.coral} ${brandTodo.coralHover}`}
          >
            <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M7 3v8M3 7h8" />
            </svg>
            কাজ যোগ করুন
          </button>
        )}
      </div>

      {firstActive && (
        <div className={`mb-2.5 rounded-xl border px-3 py-2 text-[11px] leading-snug ${brandTodo.coralBorderSoft} ${brandTodo.coralBg} ${brandTodo.coralDark}`}>
          💬 Sir, &ldquo;{firstActive.title.length > 42 ? `${firstActive.title.slice(0, 42)}…` : firstActive.title}&rdquo; টা কি হয়েছে? লাগলে বলুন — সাহায্য করব।
        </div>
      )}

      <AnimatePresence>
        {showAddForm && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden mb-3"
          >
            <div className="rounded-xl border border-white/60 bg-white/80 p-3 space-y-2.5">
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="আপনার কাজ লিখুন…"
                className="w-full bg-white border border-black/[0.06] rounded-lg px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-[#E07A5F]/40 focus:ring-1 focus:ring-[#E07A5F]/20"
                onKeyDown={(e) => { if (e.key === 'Enter') void onAdd() }}
                autoFocus
              />
              <div className="flex items-center gap-1.5 flex-wrap">
                {(['low', 'normal', 'high', 'urgent'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setNewPriority(p)}
                    className={`px-2 py-0.5 rounded-md text-[9px] font-bold transition-colors ${
                      newPriority === p
                        ? `${brandTodo.coralBtn} text-white`
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
                  onClick={() => onShowAdd()}
                  className="flex-1 py-1.5 rounded-lg border border-black/[0.06] text-[10px] text-slate-500 font-semibold hover:bg-slate-50"
                >
                  বাতিল
                </button>
                <button
                  type="button"
                  onClick={() => void onAdd()}
                  disabled={!newTitle.trim() || adding}
                  className={`flex-1 py-1.5 rounded-lg text-white text-[10px] font-bold transition-colors disabled:opacity-40 ${brandTodo.coralBtn}`}
                >
                  {adding ? '…' : 'যোগ করুন'}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 min-h-0">
        <UnifiedTodoList todos={todos} onToggle={onToggle} onDelete={onDelete} />
      </div>
    </div>
  )
}

function AgentFullWidthSection({
  todos,
  dayShiftActive,
  onToggle,
  onDelete,
}: {
  todos: Todo[]
  dayShiftActive: boolean
  onToggle: (todo: Todo) => void
  onDelete: (id: string) => void
}) {
  const done = todos.filter((t) => t.status === 'completed').length
  const active = todos.filter((t) => t.status !== 'completed').length

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm">🤖</span>
        <h3 className="text-xs font-bold text-slate-700 flex-1">এজেন্টের আজকের কাজ</h3>
        {dayShiftActive && (
          <span className="text-[9px] font-semibold text-amber-700 bg-amber-50 border border-amber-200/70 px-1.5 py-0.5 rounded-full animate-pulse">
            live
          </span>
        )}
        <span className="text-[10px] font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full tabular-nums">
          {active} active · {done} done
        </span>
      </div>
      <UnifiedTodoList todos={todos} readOnly onToggle={onToggle} onDelete={onDelete} />
      <button
        type="button"
        onClick={() => {
          if (!tryOpenOfficeLiveThread()) {
            toast('🏢 অফিস chat — উপরে সবুজ banner ট্যাপ করুন', { duration: 3500 })
          }
        }}
        className="mt-3 text-[10px] font-medium text-slate-500 hover:text-[#E07A5F] transition-colors"
      >
        🏢 অফিস chat-এ live — কাজ চললে এখানে দেখুন
      </button>
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
    () => sortAgentTodosByDutyTime(todos.filter((t) => isAgentTodoSource(t.source))),
    [todos],
  )

  const ownerTasksToday = useMemo(
    () => sortOwnerTodos(filterOwnerTasksToday(todos)),
    [todos],
  )

  const hasOwnerSplit = ownerTasksToday.length > 0

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
          body: JSON.stringify({
            title: newTitle.trim(),
            priority: newPriority,
            source: 'owner',
            dueDate: ownerDueDateIso(),
          }),
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

  const totalActive = todos.filter(
    (t) => t.status !== 'completed' && !isFailedStatus(t.status),
  ).length

  return (
    <div className="px-4 py-5 sm:px-5 sm:py-6">
      <div className="mb-4">
        <h2 className="text-base font-bold text-slate-800">Today&rsquo;s Tasks</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          {totalActive} active
          {hasOwnerSplit ? ' · Boss + Agent split' : ''}
        </p>
      </div>

      {hasOwnerSplit ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-stretch">
          <div className="order-2 md:order-1">
            <AgentCompactCard
              todos={agentTodos}
              dayShiftActive={dayShiftActive}
              onToggle={toggleTodo}
              onDelete={deleteTodo}
            />
          </div>
          <div className="order-1 md:order-2">
            <BossTodoFrame
              todos={ownerTasksToday}
              showAddForm={showAdd}
              onShowAdd={() => setShowAdd((v) => !v)}
              onAdd={addTodo}
              onToggle={toggleTodo}
              onDelete={deleteTodo}
              adding={adding}
              newTitle={newTitle}
              setNewTitle={setNewTitle}
              newPriority={newPriority}
              setNewPriority={setNewPriority}
            />
          </div>
        </div>
      ) : (
        <AgentFullWidthSection
          todos={agentTodos}
          dayShiftActive={dayShiftActive}
          onToggle={toggleTodo}
          onDelete={deleteTodo}
        />
      )}
    </div>
  )
}
