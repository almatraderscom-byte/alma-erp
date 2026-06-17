'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import toast from 'react-hot-toast'
import { sortTodosForDisplay } from '@/agent/lib/todo-sort'
import { ownerDueDateIso } from './todo-panel-utils'

export interface Todo {
  id: string
  title: string
  description: string | null
  priority: string
  status: string
  dueDate: string | null
  source: string
  dutyKey?: string | null
  createdAt: string
  completedAt: string | null
}

interface TodoContextValue {
  todos: Todo[]
  loading: boolean
  active: Todo[]
  completed: Todo[]
  cancelled: Todo[]
  /** Office day-shift is actively running — faster poll interval. */
  dayShiftActive: boolean
  refresh: () => Promise<void>
  add: (input: { title: string; priority?: string; description?: string }) => Promise<void>
  toggle: (todo: Todo) => Promise<void>
  remove: (id: string) => Promise<void>
}

const TodoContext = createContext<TodoContextValue | null>(null)

const POLL_MS = 30_000
const POLL_MS_LIVE = 12_000

export function AgentTodoProvider({ children }: { children: ReactNode }) {
  const [todos, setTodos] = useState<Todo[]>([])
  const [loading, setLoading] = useState(true)
  const [dayShiftActive, setDayShiftActive] = useState(false)
  const toastedRef = useRef<Set<string>>(new Set())
  const previousTodosRef = useRef<Todo[]>([])

  const refresh = useCallback(async () => {
    try {
      const [todoRes, shiftRes] = await Promise.all([
        fetch('/api/assistant/todos?includeCompleted=true', { cache: 'no-store' }),
        fetch('/api/assistant/day-shift', { cache: 'no-store' }).catch(() => null),
      ])
      if (!todoRes.ok) return
      const data = (await todoRes.json()) as { todos: Todo[] }
      const next = data.todos ?? []

      if (shiftRes?.ok) {
        const shift = (await shiftRes.json()) as { active?: boolean }
        setDayShiftActive(Boolean(shift.active))
      }

      if (previousTodosRef.current.length > 0) {
        const prevById = new Map(previousTodosRef.current.map(t => [t.id, t.status]))
        for (const t of next) {
          if (
            t.status === 'completed' &&
            prevById.get(t.id) &&
            prevById.get(t.id) !== 'completed' &&
            !toastedRef.current.has(t.id)
          ) {
            toastedRef.current.add(t.id)
            toast.success(`✅ ${t.title}`, { duration: 4500 })
          }
        }
      } else {
        for (const t of next) if (t.status === 'completed') toastedRef.current.add(t.id)
      }

      previousTodosRef.current = next
      setTodos(next)
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()

    let timer: ReturnType<typeof setInterval> | null = null
    const interval = () => (dayShiftActive ? POLL_MS_LIVE : POLL_MS)

    function start() {
      stop()
      timer = setInterval(() => void refresh(), interval())
    }
    function stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
    if (typeof document !== 'undefined') {
      if (document.visibilityState === 'visible') start()
      const onVis = () => {
        if (document.visibilityState === 'visible') {
          void refresh()
          start()
        } else {
          stop()
        }
      }
      document.addEventListener('visibilitychange', onVis)
      return () => {
        stop()
        document.removeEventListener('visibilitychange', onVis)
      }
    }
    return stop
  }, [refresh, dayShiftActive])

  const active = useMemo(
    () => sortTodosForDisplay(todos.filter(t => t.status !== 'completed' && t.status !== 'cancelled' && t.status !== 'failed')),
    [todos],
  )
  const completed = useMemo(
    () => todos.filter(t => t.status === 'completed'),
    [todos],
  )
  const cancelled = useMemo(
    () => todos.filter(t => t.status === 'cancelled' || t.status === 'failed'),
    [todos],
  )

  const add = useCallback(
    async (input: { title: string; priority?: string; description?: string }) => {
      const res = await fetch('/api/assistant/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: input.title.trim(),
          priority: input.priority ?? 'normal',
          description: input.description,
          source: 'owner',
          dueDate: ownerDueDateIso(),
        }),
      })
      if (res.ok) {
        toast.success('Task added')
        void refresh()
      } else {
        toast.error('Failed to add task')
      }
    },
    [refresh],
  )

  const toggle = useCallback(
    async (todo: Todo) => {
      const newStatus = todo.status === 'completed' ? 'pending'
        : (todo.status === 'in_progress' || todo.status === 'running') ? 'completed'
        : 'completed'
      // Optimistic update for snappy UX.
      setTodos(prev =>
        prev.map(t =>
          t.id === todo.id
            ? {
                ...t,
                status: newStatus,
                completedAt: newStatus === 'completed' ? new Date().toISOString() : null,
              }
            : t,
        ),
      )
      try {
        await fetch('/api/assistant/todos', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: todo.id, status: newStatus }),
        })
      } finally {
        void refresh()
      }
    },
    [refresh],
  )

  const remove = useCallback(
    async (id: string) => {
      setTodos(prev => prev.filter(t => t.id !== id))
      try {
        await fetch(`/api/assistant/todos?id=${id}`, { method: 'DELETE' })
      } finally {
        void refresh()
      }
    },
    [refresh],
  )

  const value: TodoContextValue = useMemo(
    () => ({ todos, loading, active, completed, cancelled, dayShiftActive, refresh, add, toggle, remove }),
    [todos, loading, active, completed, cancelled, dayShiftActive, refresh, add, toggle, remove],
  )

  return <TodoContext.Provider value={value}>{children}</TodoContext.Provider>
}

export function useAgentTodos(): TodoContextValue {
  const ctx = useContext(TodoContext)
  if (!ctx) {
    throw new Error('useAgentTodos must be used within AgentTodoProvider')
  }
  return ctx
}

/** Safe variant — returns null when no provider is mounted (used by AgentTodoPanel
 *  to support both inside-empty-state usage AND inside the global drawer). */
export function useAgentTodosOptional(): TodoContextValue | null {
  return useContext(TodoContext)
}
