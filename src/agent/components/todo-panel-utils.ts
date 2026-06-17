import { DAILY_DUTIES } from '@/agent/lib/agent-duties'
import type { Todo } from './AgentTodoContext'

const DUTY_ORDER = new Map<string, number>(DAILY_DUTIES.map((d, i) => [d.duty, i]))

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
  return /approval\s*লাগবে|আপনার\s*approval|⏳\s*Sir,\s*এটা\s*হয়নি/i.test(d)
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
