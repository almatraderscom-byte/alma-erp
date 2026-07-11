import { DAILY_DUTIES } from '@/agent/lib/agent-duties'
import type { Todo } from './AgentTodoContext'

const DUTY_ORDER = new Map<string, number>(DAILY_DUTIES.map((d, i) => [d.duty, i]))

export function todayYmdClient(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** Owner todo counts for today's Boss panel split. */
export function isOwnerDueToday(todo: Todo, today = todayYmdClient()): boolean {
  if (!isOwnerTodoSource(todo.source)) return false
  if (todo.dueDate) {
    return todo.dueDate.slice(0, 10) === today
  }
  return todo.createdAt.slice(0, 10) === today
    || new Date(todo.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }) === today
}

export function filterOwnerTasksToday(todos: Todo[], today = todayYmdClient()): Todo[] {
  return todos.filter((t) => isOwnerDueToday(t, today))
}

export function isRejectedStatus(status: string): boolean {
  return status === 'rejected'
}

export function isCancelledStatus(status: string): boolean {
  return status === 'cancelled' || status === 'failed'
}

export function isFailedStatus(status: string): boolean {
  return isCancelledStatus(status) || isRejectedStatus(status)
}

export function ownerDueDateIso(today = todayYmdClient()): string {
  return `${today}T00:00:00+06:00`
}

export function isAgentTodoSource(source: string): boolean {
  return source === 'day_shift' || source === 'scheduler' || source === 'agent'
}

export function isOwnerTodoSource(source: string): boolean {
  return source === 'owner'
}

/** Phase C — pending row waiting on owner approval. */
export function isApprovalPendingTodo(todo: Todo): boolean {
  if (todo.status !== 'pending') return false
  const d = todo.description ?? ''
  return /approval\s*লাগবে|আপনার\s*approval|⏳\s*Boss,\s*এটা\s*হয়নি/i.test(d)
}

export function isInProgressStatus(status: string): boolean {
  return status === 'in_progress' || status === 'running'
}

export function sortAgentTodosByDutyTime(todos: Todo[]): Todo[] {
  return [...todos].sort((a, b) => {
    const ai = a.dutyKey ? (DUTY_ORDER.get(a.dutyKey) ?? 999) : 999
    const bi = b.dutyKey ? (DUTY_ORDER.get(b.dutyKey) ?? 999) : 999
    if (ai !== bi) return ai - bi
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  })
}

export function sortOwnerTodos(todos: Todo[]): Todo[] {
  return [...todos].sort((a, b) => {
    const statusRank: Record<string, number> = { in_progress: 0, pending: 1, completed: 2, cancelled: 3 }
    const sa = statusRank[a.status] ?? 1
    const sb = statusRank[b.status] ?? 1
    if (sa !== sb) return sa - sb
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  })
}

/** Click the live office banner if visible (AgentApp). */
export function tryOpenOfficeLiveThread(): boolean {
  if (typeof document === 'undefined') return false
  const btn = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.includes('Agent অফিস লাইভ') || b.textContent?.includes('অফিস লাইভ'),
  )
  if (btn) {
    btn.click()
    return true
  }
  return false
}
