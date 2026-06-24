/**
 * Stuck-todo → Plan-Drive bridge (option খ).
 *
 * The agent's daily to-do list (AgentTodo, source='agent') is its normal,
 * fire-and-forget work. Most tasks finish on the first try. But some get STUCK —
 * the agent attempted them and they didn't complete (failed), or they aged past
 * their due time while still open. Those, and ONLY those, get promoted into the
 * autonomous Plan-Driver so it pursues them until done (self-scheduled retries,
 * stuck-reason + retry-time, owner approvals).
 *
 * This is deliberately NOT "promote every pending todo" — small instant tasks the
 * agent is about to finish must not flood the slow drive loop. We promote only
 * after a task has had its normal shot and is genuinely stuck.
 *
 * No DB migration: the todo↔plan link lives in agent_kv_settings (the same KV
 * pattern as the per-plan cost overrides). Two keys per promotion:
 *   - `plandrive_promoted:<todoId>` = <planId>   (dedupe: never promote twice)
 *   - `plandrive_src_todo:<planId>` = <todoId>   (reverse link: complete the todo
 *                                                 when its driven plan finishes)
 */
import { prisma } from '@/lib/prisma'
import { createPlan, enrollPlanForAutodrive } from '@/agent/lib/planner'
import { notifyOwnerIfAway } from '@/agent/lib/notify-owner'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** A daily agent-todo is "stuck" once it has aged this long while still open. */
export const STUCK_AGE_MINUTES = 30

const PROMOTED_PREFIX = 'plandrive_promoted:'
const SRC_TODO_PREFIX = 'plandrive_src_todo:'

/** Todo statuses that mean the agent is still working / hasn't finished. */
const OPEN_TODO_STATUSES = ['pending', 'in_progress', 'running'] as const

function promotedKey(todoId: string): string {
  return `${PROMOTED_PREFIX}${todoId}`
}

function srcTodoKey(planId: string): string {
  return `${SRC_TODO_PREFIX}${planId}`
}

interface StuckTodo {
  id: string
  title: string
  description: string | null
  businessId: string
  status: string
  conversationId?: string | null
}

/**
 * Find daily agent-todos that are genuinely stuck:
 *   - source = 'agent' (the agent's OWN work, never owner-assigned tasks), AND
 *   - either it FAILED (the agent tried and could not finish), OR
 *   - it is still OPEN but already overdue / older than STUCK_AGE_MINUTES.
 *
 * dutyKey rows (recurring scheduled duties like the morning digest) are excluded —
 * those are handled by their own scheduler, not one-shot pursuit.
 */
async function loadStuckTodos(now: Date, limit: number): Promise<StuckTodo[]> {
  const ageCutoff = new Date(now.getTime() - STUCK_AGE_MINUTES * 60_000)
  const rows: StuckTodo[] = await db.agentTodo.findMany({
    where: {
      source: 'agent',
      dutyKey: null,
      OR: [
        // Agent tried and failed.
        { status: 'failed' },
        // Still open but overdue.
        { status: { in: OPEN_TODO_STATUSES }, dueDate: { lt: now } },
        // Still open and has aged past the stuck threshold (no due date set).
        { status: { in: OPEN_TODO_STATUSES }, dueDate: null, createdAt: { lt: ageCutoff } },
      ],
    },
    orderBy: [{ createdAt: 'asc' }],
    take: limit,
    select: { id: true, title: true, description: true, businessId: true, status: true },
  })
  return rows
}

/** Which of these todo ids have already been promoted (KV dedupe)? */
async function alreadyPromoted(todoIds: string[]): Promise<Set<string>> {
  if (todoIds.length === 0) return new Set()
  const rows = await prisma.agentKvSetting.findMany({
    where: { key: { in: todoIds.map(promotedKey) } },
    select: { key: true },
  })
  return new Set(rows.map((r) => r.key.slice(PROMOTED_PREFIX.length)))
}

export interface PromotionResult {
  scanned: number
  promoted: Array<{ todoId: string; planId: string; goal: string }>
}

/**
 * Sweep the daily todo list and promote stuck agent-tasks into the Plan-Driver.
 * Called once per tick, BEFORE the normal drivable-plan scan, so newly promoted
 * plans are picked up the same tick. Idempotent (KV dedupe) and bounded (`limit`).
 *
 * Each promotion:
 *   1. creates a single-step plan whose action is the todo's title,
 *   2. enrols it for autodrive (Qwen-driven; finance steps delegate to Claude via
 *      the tier router — promotion itself adds no model bias),
 *   3. writes the two-way KV link,
 *   4. pushes the owner a HIGHEST-priority heads-up (tier 2 → critical channel),
 *      because the owner asked for Plan-Drive follow-ups to always reach him first.
 */
export async function promoteStuckTodosToPlanDrive(
  opts: { limit?: number; now?: Date } = {},
): Promise<PromotionResult> {
  const now = opts.now ?? new Date()
  const limit = opts.limit ?? 10

  const candidates = await loadStuckTodos(now, limit)
  const promotedSet = await alreadyPromoted(candidates.map((t) => t.id))
  const fresh = candidates.filter((t) => !promotedSet.has(t.id))

  const promoted: PromotionResult['promoted'] = []

  for (const todo of fresh) {
    try {
      const goal = todo.title.trim() || 'Untitled task'
      const action = goal
      const doneCriteria = (todo.description?.trim() || goal)

      const plan = await createPlan({
        goal,
        steps: [{ action }],
        businessId: todo.businessId,
      })
      await enrollPlanForAutodrive(plan.id, { doneCriteria })

      // Two-way KV link (no migration). promoted:<todoId> also acts as the dedupe flag.
      await prisma.agentKvSetting.upsert({
        where: { key: promotedKey(todo.id) },
        update: { value: plan.id },
        create: { key: promotedKey(todo.id), value: plan.id },
      })
      await prisma.agentKvSetting.upsert({
        where: { key: srcTodoKey(plan.id) },
        update: { value: todo.id },
        create: { key: srcTodoKey(plan.id), value: todo.id },
      })

      // Flag the todo as actively driven so the daily dock shows it's in pursuit.
      await db.agentTodo.update({ where: { id: todo.id }, data: { status: 'in_progress' } }).catch(() => {})

      promoted.push({ todoId: todo.id, planId: plan.id, goal })

      void notifyOwnerIfAway({
        tier: 2,
        title: 'Plan-Drive — আটকে থাকা কাজ ধরলাম',
        message: `"${goal}" আটকে ছিল, এখন আমি নিজে follow-up-এ নিয়েছি — শেষ না হওয়া পর্যন্ত চেষ্টা করব।`,
        category: 'task',
      }).catch(() => {})
    } catch (err) {
      console.warn(
        '[plan-drive promote] failed to promote todo',
        todo.id,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  return { scanned: candidates.length, promoted }
}

/**
 * When a driven plan finishes, mark its source todo (if any) completed so the
 * daily dock and the Plan-Drive in-chat list agree. Safe to call for every plan —
 * a no-op when the plan wasn't born from a promoted todo.
 */
export async function completeSourceTodoForPlan(planId: string): Promise<void> {
  try {
    const link = await prisma.agentKvSetting.findUnique({ where: { key: srcTodoKey(planId) } })
    const todoId = link?.value
    if (!todoId) return
    await db.agentTodo.update({
      where: { id: todoId },
      data: { status: 'completed', completedAt: new Date() },
    })
  } catch (err) {
    console.warn(
      '[plan-drive promote] could not complete source todo for plan',
      planId,
      err instanceof Error ? err.message : String(err),
    )
  }
}

/** Read the source todo id for a driven plan (used by the in-chat UI to cross-link). */
export async function getSourceTodoId(planId: string): Promise<string | null> {
  const link = await prisma.agentKvSetting.findUnique({ where: { key: srcTodoKey(planId) } })
  return link?.value ?? null
}
