'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import toast from 'react-hot-toast'
import { useActor } from '@/contexts/ActorContext'
import { notifySuccess } from '@/lib/haptics'
import { cn } from '@/lib/utils'

/**
 * Owner todolist — pinned in the SAME top spot on every ERP page (owner request:
 * one fixed place for his tasks instead of the old agent-section panel). Shows
 * ONLY the owner's own todos (source='owner'); the agent's duty todos live in the
 * office/monitor section. Talks to /api/assistant/todos over fetch — no imports
 * from src/agent (ERP must never depend on agent code).
 *
 * Deliberately shows ALL open owner todos regardless of created/due date — the old
 * panel filtered to "today only", which made a todo added yesterday for tomorrow
 * silently vanish at midnight. A todo leaves this list only when the owner (or the
 * agent, with his approval) completes or removes it.
 */

interface OwnerTodo {
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

const POLL_MS = 60_000
const OPEN_STATUSES = new Set(['pending', 'in_progress', 'running'])
const HIDE_PREFIXES = ['/agent', '/orders/new', '/portal']

function isOpenOwnerTodo(t: OwnerTodo): boolean {
  return t.source === 'owner' && OPEN_STATUSES.has(t.status)
}

function dueLabel(dueDate: string | null): { text: string; overdue: boolean } | null {
  if (!dueDate) return null
  const dueMs = new Date(dueDate).getTime()
  if (Number.isNaN(dueMs)) return null
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const today = fmt.format(new Date())
  // Compare Dhaka calendar dates (an ISO string sliced at 10 is the UTC date,
  // which is yesterday for Dhaka times before 06:00).
  const due = fmt.format(new Date(dueMs))
  if (due === today) return { text: 'আজ', overdue: false }
  if (due < today) return { text: 'বাকি পড়ে আছে', overdue: true }
  const tomorrow = fmt.format(new Date(Date.now() + 24 * 60 * 60 * 1000))
  if (due === tomorrow) return { text: 'আগামীকাল', overdue: false }
  const [, m, d] = due.split('-')
  return { text: `${Number(d)}/${Number(m)}`, overdue: false }
}

export function OwnerTodoBar() {
  const { role } = useActor()
  const path = usePathname() ?? ''
  const reduceMotion = useReducedMotion()
  const [todos, setTodos] = useState<OwnerTodo[]>([])
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  // Just-completed rows linger with a strikethrough for a beat before dropping out.
  const [justDone, setJustDone] = useState<Set<string>>(new Set())
  const openRef = useRef(open)
  openRef.current = open

  const isOwner = role === 'SUPER_ADMIN'
  const hidden = !isOwner || HIDE_PREFIXES.some((p) => path.startsWith(p))

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/todos', { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as { todos?: OwnerTodo[] }
      setTodos((data.todos ?? []).filter((t) => t.source === 'owner'))
    } catch {
      /* offline / transient — keep the last list */
    }
  }, [])

  useEffect(() => {
    if (hidden) return
    void refresh()
    const onChanged = () => void refresh()
    window.addEventListener('alma:todos-changed', onChanged)
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, POLL_MS)
    const onVis = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('alma:todos-changed', onChanged)
      document.removeEventListener('visibilitychange', onVis)
      clearInterval(timer)
    }
  }, [hidden, refresh])

  const openTodos = useMemo(
    () => todos
      .filter((t) => isOpenOwnerTodo(t) || justDone.has(t.id))
      .sort((a, b) => {
        const rank: Record<string, number> = { high: 0, normal: 1, low: 2 }
        const ra = rank[a.priority] ?? 1
        const rb = rank[b.priority] ?? 1
        if (ra !== rb) return ra - rb
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      }),
    [todos, justDone],
  )
  const openCount = openTodos.filter((t) => !justDone.has(t.id)).length

  const addTodo = useCallback(async () => {
    const title = draft.trim()
    if (!title || saving) return
    setSaving(true)
    try {
      const res = await fetch('/api/assistant/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, source: 'owner' }),
      })
      if (res.ok) {
        setDraft('')
        void refresh()
      } else {
        toast.error('টুডু যোগ হয়নি — আবার চেষ্টা করুন।')
      }
    } catch {
      toast.error('টুডু যোগ হয়নি — আবার চেষ্টা করুন।')
    } finally {
      setSaving(false)
    }
  }, [draft, saving, refresh])

  const completeTodo = useCallback(async (todo: OwnerTodo) => {
    notifySuccess()
    setJustDone((prev) => new Set(prev).add(todo.id))
    setTodos((prev) => prev.map((t) => (t.id === todo.id ? { ...t, status: 'completed' } : t)))
    window.setTimeout(() => {
      setJustDone((prev) => {
        const next = new Set(prev)
        next.delete(todo.id)
        return next
      })
    }, 1800)
    try {
      await fetch('/api/assistant/todos', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: todo.id, status: 'completed' }),
      })
    } finally {
      void refresh()
    }
  }, [refresh])

  const removeTodo = useCallback(async (todo: OwnerTodo) => {
    setTodos((prev) => prev.filter((t) => t.id !== todo.id))
    try {
      // Soft-cancel (keeps the record) — matches how agent-side removal behaves.
      await fetch('/api/assistant/todos', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: todo.id, status: 'cancelled' }),
      })
    } finally {
      void refresh()
    }
  }, [refresh])

  if (hidden) return null

  return (
    <>
      {/* Collapsed pill — same fixed top-right spot on every ERP page. */}
      <div
        className="owner-todo-fab pointer-events-none fixed right-0 z-[70]"
        style={{ top: 'max(0.625rem, env(safe-area-inset-top))', paddingRight: 'max(0.75rem, env(safe-area-inset-right))' }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={`আমার টুডু — ${openCount}টি বাকি`}
          aria-expanded={open}
          className={cn(
            'pointer-events-auto flex min-h-[36px] items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold shadow-elevated backdrop-blur-md transition-all active:scale-[0.97]',
            openCount > 0
              ? 'border-gold-dim/50 bg-gold/15 text-gold-lt'
              : 'border-border-subtle bg-card/90 text-muted',
          )}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M9 12l2 2 4-4" />
          </svg>
          <span>টুডু</span>
          {openCount > 0 && (
            <span className="tabular-nums rounded-full bg-gold/25 px-1.5 py-px text-[11px] leading-tight">
              {openCount}
            </span>
          )}
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <>
            {/* Tap-outside backdrop (transparent — the panel is small). */}
            <div className="fixed inset-0 z-[71]" onClick={() => setOpen(false)} aria-hidden />
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
              className="owner-todo-panel fixed z-[72] w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-border-subtle bg-card/85 shadow-float backdrop-blur-xl"
              style={{
                top: 'calc(max(0.625rem, env(safe-area-inset-top)) + 2.75rem)',
                right: 'max(0.75rem, env(safe-area-inset-right))',
              }}
              role="dialog"
              aria-label="আমার টুডু তালিকা"
            >
              <div className="flex items-center justify-between border-b border-border-subtle px-3.5 py-2.5">
                <span className="text-[13px] font-bold text-cream">আমার টুডু</span>
                <span className="text-[11px] tabular-nums text-muted">{openCount}টি বাকি</span>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void addTodo()
                }}
                className="flex items-center gap-2 border-b border-border-subtle px-3 py-2"
              >
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="নতুন টুডু লিখুন…"
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-cream placeholder:text-muted focus:outline-none"
                  maxLength={200}
                />
                <button
                  type="submit"
                  disabled={!draft.trim() || saving}
                  className="rounded-lg border border-gold-dim/40 bg-gold/10 px-2.5 py-1 text-[12px] font-semibold text-gold-lt transition-all disabled:opacity-40"
                >
                  যোগ
                </button>
              </form>

              <div className="max-h-[50vh] overflow-y-auto overscroll-contain">
                {openTodos.length === 0 ? (
                  <p className="px-3.5 py-5 text-center text-[12px] text-muted">
                    কোনো টুডু বাকি নেই — এজেন্টকে বললে বা এখানে লিখলে যুক্ত হবে।
                  </p>
                ) : (
                  <ul className="flex flex-col px-1.5 py-1.5">
                    {openTodos.map((t) => {
                      const done = justDone.has(t.id)
                      const due = dueLabel(t.dueDate)
                      return (
                        <li key={t.id} className="group flex items-start gap-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-bg-2">
                          <button
                            type="button"
                            onClick={() => !done && void completeTodo(t)}
                            aria-label={`"${t.title}" সম্পন্ন করুন`}
                            className="mt-[3px] shrink-0"
                          >
                            {done ? (
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                            ) : (
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted transition-colors group-hover:text-gold"><circle cx="12" cy="12" r="9" /></svg>
                            )}
                          </button>
                          <span className="min-w-0 flex-1">
                            <span className={cn(
                              'block break-words text-[13px] leading-snug [overflow-wrap:anywhere]',
                              done ? 'text-muted line-through' : 'text-cream',
                            )}>
                              {t.title}
                            </span>
                            {(due || t.priority === 'high') && (
                              <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px]">
                                {t.priority === 'high' && <span className="font-semibold text-danger">জরুরি</span>}
                                {due && (
                                  <span className={due.overdue ? 'font-semibold text-warning' : 'text-muted'}>
                                    ⏰ {due.text}
                                  </span>
                                )}
                              </span>
                            )}
                          </span>
                          {!done && (
                            <button
                              type="button"
                              onClick={() => void removeTodo(t)}
                              aria-label={`"${t.title}" তালিকা থেকে সরান`}
                              className="mt-[2px] shrink-0 rounded-md p-1 text-muted opacity-60 transition-all hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                            </button>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  )
}
