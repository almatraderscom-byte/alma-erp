/**
 * Hard owner call lock — blocks ALL Twilio outbound to owner until the given time.
 * Set by request_salah_delay / salah_override; checked by worker before every call + retry.
 */
import { prisma } from '@/lib/prisma'

export const OWNER_CALL_LOCK_KEY = 'owner_call_lock_until'

export type OwnerCallLockStatus = {
  locked: boolean
  until?: Date
  source?: 'kv' | 'salah_override'
}

function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d : null
}

export async function getOwnerCallLockUntil(): Promise<Date | null> {
  const row = await prisma.agentKvSetting.findUnique({
    where: { key: OWNER_CALL_LOCK_KEY },
    select: { value: true },
  })
  return parseIsoDate(row?.value)
}

/** Latest active delay_until from salah_overrides (fallback if KV missing). */
export async function getActiveSalahDelayUntil(now = new Date()): Promise<Date | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await (prisma as any).agentSalahOverride.findMany({
    where: { delayUntil: { gt: now } },
    select: { delayUntil: true },
    orderBy: { delayUntil: 'desc' },
    take: 10,
  }) as Array<{ delayUntil: Date | null }>

  return rows[0]?.delayUntil ?? null
}

export async function isOwnerCallLocked(now = new Date()): Promise<OwnerCallLockStatus> {
  const kv = await getOwnerCallLockUntil()
  if (kv && now < kv) return { locked: true, until: kv, source: 'kv' }

  const salahDelay = await getActiveSalahDelayUntil(now)
  if (salahDelay && now < salahDelay) {
    return { locked: true, until: salahDelay, source: 'salah_override' }
  }

  return { locked: false }
}

/** Persist global lock. When extend=true, keeps the later of existing vs new. */
export async function setOwnerCallLockUntil(until: Date, { extend = true } = {}): Promise<void> {
  if (!Number.isFinite(until.getTime())) return

  let effective = until
  if (extend) {
    const existing = await getOwnerCallLockUntil()
    if (existing && existing > effective) effective = existing
  }

  await prisma.agentKvSetting.upsert({
    where: { key: OWNER_CALL_LOCK_KEY },
    create: { key: OWNER_CALL_LOCK_KEY, value: effective.toISOString() },
    update: { value: effective.toISOString() },
  })
}
