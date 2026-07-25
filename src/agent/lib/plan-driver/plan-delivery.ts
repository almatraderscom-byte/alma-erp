/**
 * G5 (owner ruling 2026-07-26) — when a plan finishes, the RESULT comes to Boss.
 *
 * Autonomous plans run in their own drive conversation, which is exactly right
 * for keeping synthetic step messages out of his chat — but it also meant the
 * outcome lived somewhere he never looks. He had to open a panel and read a step
 * result to find out what happened. His standard is the opposite: the agent wakes
 * up on its own and tells him, the way a finished background job already does.
 *
 * So a terminal plan posts ONE short message into his own chat: what it was, what
 * came of it, and — when it stopped instead of finishing — what it needs from him.
 * Idempotent: a plan delivers once, tracked in KV.
 */
import { prisma } from '@/lib/prisma'
import type { Plan } from '@/agent/lib/planner'
import { getOwnerSessionPointer } from '@/agent/lib/owner-session'
import { postAssistantMessage } from '@/agent/lib/job-delivery'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const DELIVERED_PREFIX = 'plan_delivered:'

export type PlanOutcomeKind = 'done' | 'stopped'

/** The chat Boss actually reads. Falls back to the plan's own thread. */
async function ownerChatId(plan: Pick<Plan, 'conversationId'>): Promise<string | null> {
  try {
    const pointer = await getOwnerSessionPointer()
    if (pointer.conversationId) return pointer.conversationId
  } catch { /* fall through */ }
  return plan.conversationId ?? null
}

/** The last real thing a step produced — the only honest thing to report. */
export function lastStepResult(plan: Pick<Plan, 'steps'>): string {
  for (let i = plan.steps.length - 1; i >= 0; i--) {
    const s = plan.steps[i]
    if (s.status !== 'done') continue
    const r = typeof s.result === 'string' ? s.result.trim() : ''
    if (r) return r
  }
  return ''
}

/** Pure — the message Boss sees. Kept short; the panel holds the detail. */
export function buildPlanDeliveryMessage(
  plan: Pick<Plan, 'goal' | 'steps'>,
  kind: PlanOutcomeKind,
  reason: string,
): string {
  const result = lastStepResult(plan).slice(0, 900)
  const doneCount = plan.steps.filter((s) => s.status === 'done').length

  if (kind === 'done') {
    return [
      `✅ **${plan.goal}** — শেষ।`,
      result || reason,
      `_(নিজে থেকেই করেছি · ${doneCount}/${plan.steps.length} ধাপ)_`,
    ].filter(Boolean).join('\n\n')
  }

  return [
    `⏸️ **${plan.goal}** — থেমেছি, আপনার সিদ্ধান্ত দরকার।`,
    `**কেন:** ${reason}`,
    result ? `**এ পর্যন্ত যা পেয়েছি:** ${result}` : '',
    `_(${doneCount}/${plan.steps.length} ধাপ হয়েছে · Plan-Drive প্যানেলে "আবার চালাও" বা "বাদ দাও" আছে)_`,
  ].filter(Boolean).join('\n\n')
}

/**
 * Deliver a plan's outcome into Boss's chat, exactly once.
 * Fail-open — a delivery problem must never break the drive tick.
 */
export async function deliverPlanOutcome(
  plan: Pick<Plan, 'id' | 'goal' | 'steps' | 'conversationId'>,
  kind: PlanOutcomeKind,
  reason: string,
): Promise<boolean> {
  const key = `${DELIVERED_PREFIX}${plan.id}`
  try {
    const already = await prisma.agentKvSetting.findUnique({ where: { key } })
    if (already?.value) return false

    const chatId = await ownerChatId(plan)
    if (!chatId) return false

    await postAssistantMessage(chatId, buildPlanDeliveryMessage(plan, kind, reason))
    await prisma.agentKvSetting.upsert({
      where: { key },
      update: { value: kind },
      create: { key, value: kind },
    })
    return true
  } catch (err) {
    console.warn('[plan-delivery] failed open:', err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * G6 — the time budget. Ordinary work finishes inside this; anything longer is
 * reported honestly rather than sitting silent. Owner-tunable, no redeploy.
 */
export const PLAN_TIME_BUDGET_KEY = 'autodrive_plan_budget_min'
export const DEFAULT_PLAN_BUDGET_MIN = 30

export async function planBudgetMs(): Promise<number> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: PLAN_TIME_BUDGET_KEY } })
    const n = row?.value ? parseInt(row.value, 10) : NaN
    if (Number.isFinite(n) && n >= 5 && n <= 24 * 60) return n * 60_000
  } catch { /* default below */ }
  return DEFAULT_PLAN_BUDGET_MIN * 60_000
}

/**
 * When the current attempt started. Normally the plan's creation, but "আবার
 * চালাও" restarts the clock — otherwise resuming a day-old plan would blow the
 * budget on its very first tick and escalate straight back at Boss, which is
 * exactly what happened the first time this shipped (2026-07-26).
 */
export const PLAN_BUDGET_FROM_PREFIX = 'plan_budget_from:'

export async function markBudgetRestart(planId: string, now = new Date()): Promise<void> {
  const key = `${PLAN_BUDGET_FROM_PREFIX}${planId}`
  await prisma.agentKvSetting
    .upsert({ where: { key }, update: { value: now.toISOString() }, create: { key, value: now.toISOString() } })
    .catch(() => {})
}

export async function budgetStartedAt(plan: Pick<Plan, 'id' | 'createdAt'>): Promise<Date | null> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: `${PLAN_BUDGET_FROM_PREFIX}${plan.id}` } })
    if (row?.value) {
      const t = Date.parse(row.value)
      if (Number.isFinite(t)) return new Date(t)
    }
  } catch { /* fall back to creation */ }
  return plan.createdAt ? new Date(plan.createdAt) : null
}

/** Has this attempt run past its budget without finishing? Pure. */
export function isOverBudget(
  startedAt: Date | null,
  budgetMs: number,
  now = new Date(),
): boolean {
  if (!startedAt) return false
  return now.getTime() - startedAt.getTime() > budgetMs
}

/** How long this attempt has been running, in owner-facing Bangla. */
export function elapsedBn(startedAt: Date | null, now = new Date()): string {
  if (!startedAt) return ''
  const min = Math.round((now.getTime() - startedAt.getTime()) / 60_000)
  if (min < 60) return `${min} মিনিট`
  const h = Math.round(min / 60)
  return h < 24 ? `${h} ঘণ্টা` : `${Math.round(h / 24)} দিন`
}
