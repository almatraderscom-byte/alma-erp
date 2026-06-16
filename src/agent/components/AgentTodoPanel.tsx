'use client'

import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface Todo {
  id: string
  title: string
  description: string | null
  priority: string
  status: string
  dueDate: string | null
  source: string
  createdAt: string
  completedAt: string | null
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

export function AgentTodoPanel() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newPriority, setNewPriority] = useState('normal')
  const [adding, setAdding] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/todos')
      if (!res.ok) return
      const data = await res.json() as { todos: Todo[] }
      setTodos(data.todos ?? [])
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const activeTodos = todos.filter(t => t.status !== 'completed' && t.status !== 'cancelled')
  const completedTodos = todos.filter(t => t.status === 'completed')

  async function addTodo() {
    if (!newTitle.trim() || adding) return
    setAdding(true)
    try {
      const res = await fetch('/api/assistant/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim(), priority: newPriority }),
      })
      if (res.ok) {
        setNewTitle('')
        setNewPriority('normal')
        setShowAdd(false)
        void load()
      }
    } catch { /* ignore */ } finally {
      setAdding(false)
    }
  }

  async function toggleTodo(todo: Todo) {
    const newStatus = todo.status === 'completed' ? 'pending' : 'completed'
    try {
      await fetch('/api/assistant/todos', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: todo.id, status: newStatus }),
      })
      void load()
    } catch { /* ignore */ }
  }

  async function deleteTodo(id: string) {
    try {
      await fetch(`/api/assistant/todos?id=${id}`, { method: 'DELETE' })
      void load()
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

  return (
    <div className="px-5 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-bold text-slate-800">Tasks</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {activeTodos.length} active{completedTodos.length > 0 ? ` · ${completedTodos.length} done` : ''}
          </p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#E07A5F]/10 text-[#E07A5F] text-xs font-semibold hover:bg-[#E07A5F]/20 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M7 3v8M3 7h8" />
          </svg>
          Add
        </button>
      </div>

      {/* Add form */}
      <AnimatePresence>
        {showAdd && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden mb-4"
          >
            <div className="bg-white border border-black/[0.06] rounded-2xl p-4 shadow-sm space-y-3">
              <input
                type="text"
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                placeholder="What needs to be done?"
                className="w-full bg-slate-50 border border-black/[0.06] rounded-xl px-3.5 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-[#E07A5F]/40 focus:ring-1 focus:ring-[#E07A5F]/20"
                onKeyDown={e => { if (e.key === 'Enter') void addTodo() }}
                autoFocus
              />
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">Priority</span>
                {(['low', 'normal', 'high', 'urgent'] as const).map(p => (
                  <button
                    key={p}
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
                  onClick={() => setShowAdd(false)}
                  className="flex-1 py-2 rounded-xl border border-black/[0.06] text-xs text-slate-500 font-semibold hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
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

      {/* Active todos */}
      {activeTodos.length === 0 && !showAdd ? (
        <div className="text-center py-10">
          <p className="text-3xl mb-3 opacity-30">✓</p>
          <p className="text-sm font-semibold text-slate-600">All caught up</p>
          <p className="text-xs text-slate-400 mt-1">No pending tasks. Add one or let the agent create them.</p>
        </div>
      ) : (
        <div className="space-y-2">
          <AnimatePresence>
            {activeTodos.map(todo => (
              <motion.div
                key={todo.id}
                layout
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="group flex items-start gap-3 bg-white border border-black/[0.06] rounded-xl p-3.5 hover:shadow-sm transition-shadow"
              >
                <button
                  onClick={() => void toggleTodo(todo)}
                  className="mt-0.5 w-5 h-5 rounded-md border-2 border-slate-300 hover:border-[#E07A5F] transition-colors shrink-0 flex items-center justify-center"
                >
                  {todo.status === 'in_progress' && (
                    <span className="w-2 h-2 rounded-sm bg-[#E07A5F]" />
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-slate-800 leading-snug">{todo.title}</p>
                    {todo.priority !== 'normal' && (
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${PRIORITY_COLORS[todo.priority] ?? 'bg-slate-400'}`} />
                    )}
                  </div>
                  {todo.description && (
                    <p className="text-xs text-slate-500 mt-1 line-clamp-2">{todo.description}</p>
                  )}
                  <div className="flex items-center gap-2 mt-1.5">
                    {todo.source === 'agent' && (
                      <span className="text-[9px] font-bold uppercase tracking-wider text-[#E07A5F] bg-[#E07A5F]/10 px-1.5 py-0.5 rounded">Agent</span>
                    )}
                    {todo.dueDate && (
                      <span className="text-[10px] text-slate-400">
                        Due {new Date(todo.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => void deleteTodo(todo.id)}
                  className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-500 transition-all shrink-0 mt-0.5"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M4 4l6 6M10 4l-6 6" />
                  </svg>
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Completed */}
      {completedTodos.length > 0 && (
        <div className="mt-5">
          <button
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
                className="overflow-hidden space-y-1.5"
              >
                {completedTodos.slice(0, 10).map(todo => (
                  <div
                    key={todo.id}
                    className="group flex items-center gap-3 rounded-xl px-3.5 py-2.5 hover:bg-slate-50 transition-colors"
                  >
                    <button
                      onClick={() => void toggleTodo(todo)}
                      className="w-5 h-5 rounded-md bg-emerald-100 border border-emerald-300 flex items-center justify-center shrink-0"
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#059669" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 5l2.5 2.5L8 3" />
                      </svg>
                    </button>
                    <p className="text-sm text-slate-400 line-through flex-1">{todo.title}</p>
                    <button
                      onClick={() => void deleteTodo(todo.id)}
                      className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-500 transition-all shrink-0"
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <path d="M3 3l6 6M9 3l-6 6" />
                      </svg>
                    </button>
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  )
}
