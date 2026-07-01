/**
 * Shared salah-delay engine — the ONE place that pauses namaz reminders + owner
 * calls for a bounded number of minutes. Used by:
 *   - the request_salah_delay tool (owner voice/text via the head), and
 *   - the typed-snooze intercept in core.ts ("আমাকে ৩০ মিনিট দাও"), and
 *   - (via the internal route) the "🕐 পরে পড়বো" Telegram button.
 *
 * It ALWAYS writes BOTH levers so a call can never slip through:
 *   1. a per-waqt `agentSalahOverride.delayUntil` (scheduler skips the waqt), AND
 *   2. the global `owner_call_lock_until` KV (blocks ALL Twilio outbound).
 * Only reports success after both writes land — callers must not claim
 * "reminder off" unless this returns non-null.
 *
 * Bounded by the moral duty window (prayer − 15 min … prayer + 30 min): outside
 * it, returns null (encourage prayer, never fake a lock).
 */
import { prisma } from '@/lib/prisma'
import { getDhakaSchedule } from '@/agent/lib/dhaka-schedule'
import { WAQTS, type Waqt } from '@/agent/lib/salah-context'
import { computeLockUntil, isWithinDutyWindow } from '@/lib/salah/duty-window'
import { setOwnerCallLockUntil } from '@/lib/owner-call-lock'
import { todayYmdDhaka, dhakaMidnightUtc } from '@/lib/agent-api/dhaka-date'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/**
 * The waqt whose moral duty window contains `now` (at most one — windows are 45
 * min and waqts are hours apart), or null if we're between windows. Lets the
 * typed/button paths delay the RIGHT prayer without the owner naming it.
 */
export async function resolveActiveSalahWaqt(
  now: Date = new Date(),
  dateYmd: string = todayYmdDhaka(),
): Promise<{ waqt: Waqt; prayerStartIso: string } | null> {
  const schedule = await getDhakaSchedule(dateYmd)
  for (const waqt of WAQTS) {
    const w = schedule[waqt]
    if (!w?.prayerStart) continue
    const iso = new Date(w.prayerStart).toISOString()
    if (isWithinDutyWindow(iso, now)) return { waqt, prayerStartIso: iso }
  }
  return null
}

export type SalahDelayResult = {
  waqt: string
  grantedMin: number
  resumeAt: string
  resumeAtLabel: string
}

/**
 * Lock reminders + calls for `minutes` on the given waqt. Returns null if the
 * waqt has no schedule or we're outside its duty window (caller should then
 * encourage prayer, NOT claim a lock). On success, both the per-waqt override
 * and the global call-lock are persisted.
 */
export async function applySalahDelay(args: {
  waqt: string
  minutes: number
  dateYmd?: string
  now?: Date
  /** Free-text audit note stored on the override row. */
  reason?: string
}): Promise<SalahDelayResult | null> {
  const now = args.now ?? new Date()
  const dateYmd = args.dateYmd ?? todayYmdDhaka()

  const schedule = await getDhakaSchedule(dateYmd)
  const w = schedule[args.waqt]
  if (!w?.prayerStart) return null
  const prayerStartIso = new Date(w.prayerStart).toISOString()

  const lock = computeLockUntil(prayerStartIso, args.minutes, now)
  if (!lock) return null

  const dateObj = dhakaMidnightUtc(dateYmd)
  // 1) per-waqt override — scheduler skips the waqt while delayUntil is in future
  await db.agentSalahOverride.deleteMany({ where: { date: dateObj, waqt: args.waqt } })
  await db.agentSalahOverride.create({
    data: {
      date: dateObj,
      waqt: args.waqt,
      delayUntil: lock.lockUntil,
      overrideTime: null,
      skip: false,
      reason: args.reason ?? `owner requested ${lock.grantedMin}min`,
    },
  })
  // 2) global hard call-lock — blocks ALL owner Twilio calls (the reliable lever)
  await setOwnerCallLockUntil(lock.lockUntil)

  const resumeAtLabel = lock.lockUntil.toLocaleTimeString('bn-BD', {
    timeZone: 'Asia/Dhaka',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  return {
    waqt: args.waqt,
    grantedMin: lock.grantedMin,
    resumeAt: lock.lockUntil.toISOString(),
    resumeAtLabel,
  }
}
