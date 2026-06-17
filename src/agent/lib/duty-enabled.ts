/**
 * Per-duty ON/OFF — owner toggle on Staff Monitor.
 * KV key `duty_enabled`: JSON map { [dutyKey]: boolean }. Absent key = enabled.
 */
import { prisma } from '@/lib/prisma'
import { dhakaDayBounds, todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { dutiesForToday, DAILY_DUTIES } from '@/agent/lib/agent-duties'

export const DUTY_ENABLED_KV_KEY = 'duty_enabled'

/** CS / finance / scheduler — warn owner before disabling. */
export const CRITICAL_DUTY_KEYS = new Set([
  'owner_briefing',
  'morning_dispatch',
  'cost_reconcile',
  'catchup_scan',
  'evening_proposal',
  'order_watch',
  'payment_reminders',
  'approval_tracker',
  'daily_summary',
  'token_health',
  'night_report',
])

/** Always on — no monitor toggle. */
export const DUTY_TOGGLE_LOCKED = new Set(['salah_init'])

export type DutyEnabledMap = Record<string, boolean>

export function parseDutyEnabledMap(value: string | null | undefined): DutyEnabledMap {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as DutyEnabledMap
  } catch {
    return {}
  }
}

export function isDutyEnabledSync(dutyKey: string, map: DutyEnabledMap): boolean {
  if (DUTY_TOGGLE_LOCKED.has(dutyKey)) return true
  return map[dutyKey] !== false
}

export function isCriticalDuty(dutyKey: string): boolean {
  return CRITICAL_DUTY_KEYS.has(dutyKey)
}

export async function getDutyEnabledMap(): Promise<DutyEnabledMap> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: DUTY_ENABLED_KV_KEY } })
  return parseDutyEnabledMap(row?.value)
}

/** Resolved booleans for every duty on today's roster (monitor UI). */
export async function getResolvedDutyEnabledMap(now = new Date()): Promise<Record<string, boolean>> {
  const map = await getDutyEnabledMap()
  const out: Record<string, boolean> = {}
  for (const d of dutiesForToday(now)) {
    out[d.duty] = isDutyEnabledSync(d.duty, map)
  }
  return out
}

export async function isDutyEnabled(dutyKey: string): Promise<boolean> {
  const map = await getDutyEnabledMap()
  return isDutyEnabledSync(dutyKey, map)
}

export async function setDutyEnabled(dutyKey: string, enabled: boolean): Promise<DutyEnabledMap> {
  if (DUTY_TOGGLE_LOCKED.has(dutyKey)) {
    throw new Error('duty_locked')
  }
  const map = await getDutyEnabledMap()
  const next: DutyEnabledMap = { ...map }
  if (enabled) {
    delete next[dutyKey]
  } else {
    next[dutyKey] = false
  }
  await prisma.agentKvSetting.upsert({
    where: { key: DUTY_ENABLED_KV_KEY },
    create: { key: DUTY_ENABLED_KV_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  })
  return next
}

export async function enabledDutiesForToday(now = new Date()) {
  const map = await getDutyEnabledMap()
  return dutiesForToday(now).filter((d) => isDutyEnabledSync(d.duty, map))
}

export async function cancelTodayDutyTodo(dutyKey: string, date = todayYmdDhaka()): Promise<number> {
  const { start, end } = dhakaDayBounds(date)
  const result = await prisma.agentTodo.updateMany({
    where: {
      dutyKey,
      dueDate: { gte: start, lte: end },
      status: { notIn: ['completed', 'cancelled'] },
    },
    data: { status: 'cancelled' },
  })
  return result.count
}

/** Re-enable mid-day — idempotent seed for one duty todo. */
export async function seedDutyTodoIfMissing(dutyKey: string, date = todayYmdDhaka()): Promise<boolean> {
  const def = DAILY_DUTIES.find((d) => d.duty === dutyKey)
  if (!def) return false

  const { start, end } = dhakaDayBounds(date)
  const existing = await prisma.agentTodo.findFirst({
    where: {
      dutyKey,
      dueDate: { gte: start, lte: end },
      status: { notIn: ['cancelled'] },
    },
    select: { id: true },
  })
  if (existing) return false

  await prisma.agentTodo.create({
    data: {
      title: def.label,
      priority: 'normal',
      status: 'pending',
      source: 'day_shift',
      dutyKey,
      dueDate: start,
      description: def.time ? `⏰ ${def.time} Asia/Dhaka` : null,
    },
  })
  return true
}
