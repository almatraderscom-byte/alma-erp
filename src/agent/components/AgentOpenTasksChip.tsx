'use client'

/**
 * "বাকি কাজ" chip — premium inline open-loop tracker shown at the end of the last
 * assistant reply (Claude-Code "running task" feel). Surfaces two kinds of
 * unfinished work for THIS chat:
 *   • chat_followup    — a request the agent started but hasn't finished
 *   • approval_pending — a confirm card still awaiting the owner's decision
 *
 * Collapsed: a small glowing pill "🔄 N কাজ বাকি". Tap → expands to a detail list.
 * Per chat_followup: Continue (resumes that exact work in the same chat via the
 * self-contained note) + Cancel. Per approval_pending: a pointer to its inline
 * card (Approve/Reject lives there — never duplicated here).
 *
 * Live: polls the conversation-scoped endpoint and refreshes on the global
 * `alma:open-tasks-changed` event so it updates the moment a task is tracked or
 * resolved.
 */
import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

const BN = '০১২৩৪৫৬৭৮৯'
const toBn = (n: number) => String(n).replace(/\d/g, (d) => BN[+d])

export type OpenTaskItem = {
  id: string
  kind: 'chat_followup' | 'approval_pending'
  title: string
  note: string
  pendingActionId?: string
  ageMinutes: number
}

export function notifyOpenTasksChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('alma:open-tasks-changed'))
}

function ageLabel(min: number): string {
  if (min < 1) return 'এইমাত্র'
  if (min < 60) return `${toBn(min)} মিনিট আগে`
  const h = Math.floor(min / 60)
  return `${toBn(h)} ঘণ্টা আগে`
}

export default function AgentOpenTasksChip({
  conversationId,
  onContinue,
}: {
  conversationId: string | null
  /** Resume the work in the same chat — sends the self-contained note as a turn. */
  onContinue: (resumeNote: string) => void
}) {
  const [tasks, setTasks] = useState<OpenTaskItem[]>([])
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!conversationId) {
      setTasks([])
      return
    }
    try {
      const res = await fetch(`/api/assistant/open-tasks?conversationId=${encodeURIComponent(conversationId)}`)
      if (!res.ok) return
      const data = (await res.json()) as { tasks?: OpenTaskItem[] }
      setTasks(Array.isArray(data.tasks) ? data.tasks : [])
    } catch {
      /* transient — keep last good state */
    }
  }, [conversationId])

  useEffect(() => {
    void load()
    const onChange = () => void load()
    window.addEventListener('alma:open-tasks-changed', onChange)
    // Light poll so a tracked task surfaces even without an explicit event.
    const t = setInterval(() => void load(), 20_000)
    return () => {
      window.removeEventListener('alma:open-tasks-changed', onChange)
      clearInterval(t)
    }
  }, [load])

  const handleContinue = useCallback(
    async (task: OpenTaskItem) => {
      setBusyId(task.id)
      try {
        const res = await fetch('/api/assistant/open-tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: task.id, action: 'continue' }),
        })
        const data = (await res.json().catch(() => ({}))) as { resumeNote?: string }
        const note = data.resumeNote || task.note
        setOpen(false)
        await load()
        if (note) onContinue(note)
      } finally {
        setBusyId(null)
      }
    },
    [load, onContinue],
  )

  const handleCancel = useCallback(
    async (task: OpenTaskItem) => {
      setBusyId(task.id)
      try {
        await fetch('/api/assistant/open-tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: task.id, action: 'cancel' }),
        })
        await load()
      } finally {
        setBusyId(null)
      }
    },
    [load],
  )

  if (tasks.length === 0) return null
  const count = tasks.length

  return (
    <div className="mt-3">
      {/* Collapsed pill */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group inline-flex items-center gap-2 rounded-full border border-[#E07A5F]/30 bg-gradient-to-r from-[#E07A5F]/[0.10] to-[#C45A3C]/[0.06] px-3 py-1.5 text-[12px] font-semibold text-[#E07A5F] shadow-sm transition-all hover:border-[#E07A5F]/50 hover:from-[#E07A5F]/[0.16]"
        aria-expanded={open}
      >
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#E07A5F]/60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[#E07A5F]" />
        </span>
        <span>{toBn(count)} কাজ বাকি</span>
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round"
          className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* Expanded detail list */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="mt-2 flex flex-col gap-2 rounded-2xl border border-white/[0.07] bg-card/80 p-2 backdrop-blur-sm">
              {tasks.map((t) => {
                const isPending = t.kind === 'approval_pending'
                const busy = busyId === t.id
                return (
                  <div
                    key={t.id}
                    className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3"
                  >
                    <div className="flex items-start gap-2">
                      <span aria-hidden className="mt-[1px] text-[14px] leading-none">
                        {isPending ? '🔔' : '🔄'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-semibold text-cream">{t.title}</span>
                          <span
                            className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9.5px] font-medium ${
                              isPending ? 'bg-amber-500/15 text-amber-500' : 'bg-[#E07A5F]/15 text-[#E07A5F]'
                            }`}
                          >
                            {isPending ? 'অনুমোদন বাকি' : 'অসম্পূর্ণ'}
                          </span>
                        </div>
                        {!isPending && t.note && (
                          <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-muted">{t.note}</p>
                        )}
                        <span className="mt-1 block text-[10px] text-muted/70">{ageLabel(t.ageMinutes)}</span>

                        {isPending ? (
                          <p className="mt-2 text-[11px] text-muted">
                            নিচের অনুমোদন কার্ড থেকে সিদ্ধান্ত নিন (Approve / Reject)।
                          </p>
                        ) : (
                          <div className="mt-2.5 flex gap-2">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleContinue(t)}
                              className="inline-flex items-center gap-1 rounded-lg bg-[#E07A5F] px-3 py-1.5 text-[12px] font-semibold text-white transition-all hover:bg-[#d36a4f] disabled:opacity-50"
                            >
                              {busy ? (
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="animate-spin"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
                              ) : (
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3l14 9-14 9V3z"/></svg>
                              )}
                              চালিয়ে যাও
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleCancel(t)}
                              className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] font-medium text-muted transition-all hover:bg-white/[0.05] hover:text-muted-hi disabled:opacity-50"
                            >
                              বাতিল
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
