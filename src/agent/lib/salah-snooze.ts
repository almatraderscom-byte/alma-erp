/**
 * Button-snooze engine — the ONE place that applies the "🕐 পরে পড়বো → ১৫ / ৩০
 * মিনিট" Telegram snooze. Distinct from applySalahDelay (voice/text, bounded to
 * prayer + 30 min): this snooze is allowed until the WAQT END and repeatable.
 *
 * Rules (owner spec):
 *   - 15 min : repeatable, works every time until the waqt ends.
 *   - 30 min : ONCE per waqt/day. After it is used, only 15 min works.
 *   - Both suppress calls AND reminders while the lock is active; when the lock
 *     expires the 1-min salah-snooze-followup job sends ONE reminder, then calls
 *     every 2 min until confirm / re-snooze (via the follow-up state armed here).
 *
 * Writes, in order, so a call can never slip through:
 *   1. per-waqt agentSalahOverride.delayUntil (scheduler skips the waqt)
 *   2. global owner_call_lock_until KV (blocks ALL Twilio outbound)
 *   3. follow-up state (arms the post-snooze reminder→call loop at lock expiry)
 *   4. (30 only) snooze30_used marker
 */
import { prisma } from '@/lib/prisma'
import { getDhakaSchedule } from '@/agent/lib/dhaka-schedule'
import { computeSnoozeLockUntil, SNOOZE_30_MIN } from '@/lib/salah/duty-window'
import { setOwnerCallLockUntil } from '@/lib/owner-call-lock'
import { is30SnoozeUsed, mark30SnoozeUsed, setFollowupState } from '@/lib/salah/snooze-state'
import { todayYmdDhaka, dhakaMidnightUtc } from '@/lib/agent-api/dhaka-date'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type SalahSnoozeResult =
  | { ok: true; waqt: string; minutes: number; grantedMin: number; resumeAt: string; resumeAtLabel: string }
  | { ok: false; reason: 'thirty_used' | 'outside_window' | 'no_schedule'; thirtyUsed: boolean }

/**
 * Apply a 15 or 30 min button snooze on `waqt`. Bounded by the waqt end.
 * Returns ok:false with a reason (never throws for the expected cases) so the
 * caller can reply truthfully and re-offer the right buttons.
 */
export async function applySalahButtonSnooze(args: {
  waqt: string
  minutes: number
  dateYmd?: string
  now?: Date
}): Promise<SalahSnoozeResult> {
  const now = args.now ?? new Date()
  const dateYmd = args.dateYmd ?? todayYmdDhaka()
  const minutes = args.minutes === SNOOZE_30_MIN ? SNOOZE_30_MIN : 15

  const schedule = await getDhakaSchedule(dateYmd)
  const w = schedule[args.waqt]
  const thirtyUsedBefore = await is30SnoozeUsed(dateYmd, args.waqt)
  if (!w?.prayerStart || !w?.end) {
    return { ok: false, reason: 'no_schedule', thirtyUsed: thirtyUsedBefore }
  }

  // 30-min is once per waqt/day — if already used, refuse (caller offers 15).
  if (minutes === SNOOZE_30_MIN && thirtyUsedBefore) {
    return { ok: false, reason: 'thirty_used', thirtyUsed: true }
  }

  const prayerStartIso = new Date(w.prayerStart).toISOString()
  const waqtEndIso = new Date(w.end).toISOString()
  const lock = computeSnoozeLockUntil(prayerStartIso, waqtEndIso, minutes, now)
  if (!lock) {
    return { ok: false, reason: 'outside_window', thirtyUsed: thirtyUsedBefore }
  }

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
      reason: `owner snooze ${minutes}min (button)`,
    },
  })
  // 2) global hard call-lock — blocks ALL owner Twilio calls
  await setOwnerCallLockUntil(lock.lockUntil)
  // 3) arm the post-snooze follow-up: at expiry the 1-min cron sends ONE reminder,
  //    then (2-min grace) starts calling every 2 min until confirm / re-snooze.
  //    callAt=null → reminder still owed; remindAt=null means already reminded.
  await setFollowupState(dateYmd, args.waqt, { remindAt: lock.lockUntil.toISOString(), callAt: null })
  // 4) 30-min is spent for this waqt
  if (minutes === SNOOZE_30_MIN) await mark30SnoozeUsed(dateYmd, args.waqt)

  const resumeAtLabel = lock.lockUntil.toLocaleTimeString('bn-BD', {
    timeZone: 'Asia/Dhaka',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  return {
    ok: true,
    waqt: args.waqt,
    minutes,
    grantedMin: lock.grantedMin,
    resumeAt: lock.lockUntil.toISOString(),
    resumeAtLabel,
  }
}
