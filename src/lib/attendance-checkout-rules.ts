import { prisma } from '@/lib/prisma'
import { officeHoursFor, officeLocationFor, distanceMeters, localMinutesFor } from '@/lib/attendance'
import { hasApprovedException } from '@/lib/attendance-exception'
import { leaveWaivesCheckout } from '@/lib/attendance-leave'

/**
 * Step 1 of the attendance checkout-discipline feature (ALMA_LIFESTYLE only).
 *
 * Three gates run on POST /api/attendance/check-out before the checkout is
 * recorded, ALL behind a kill-switch so production stays untouched until the
 * owner explicitly flips it on:
 *   1. time gate     — no checkout before office end time (8:00 PM)
 *   2. location gate — checkout must be from inside the office geofence
 *   3. task gate     — if the staff has tasks assigned today, ≥75% must be done
 *
 * The exception button (Step 3) and leave (Step 4) will later be able to waive
 * these gates; for now the gates are unconditional once enabled.
 */

// Only ALMA_LIFESTYLE participates for now (owner will expand later).
export const CHECKOUT_RULES_BUSINESS = 'ALMA_LIFESTYLE'

// Minimum fraction of today's assigned tasks that must be done to check out.
export const CHECKOUT_TASK_THRESHOLD = 0.75

// Tasks the staff is actually responsible for today. 'proposed' = agent draft
// not yet pushed to the staff; 'cancelled' = dropped. Neither counts toward the
// denominator. Everything else (sent/approved/carried/awaiting_proof/done/...)
// is a real assignment.
const NON_ASSIGNED_TASK_STATUSES = new Set(['proposed', 'cancelled'])

// Mirror of staff-monitor-data DONE_STATUSES — duplicated here on purpose so
// ERP code never imports from src/agent/ (one-way dependency rule).
const DONE_TASK_STATUSES = new Set(['done', 'verified', 'done_unverified', 'awaiting_proof'])

/**
 * Kill-switch. Returns true only when the rules should run for this business.
 *
 * Preview + production share one database, so the switch is ENV-based (per
 * Vercel environment) rather than a DB flag:
 *   - ATTENDANCE_CHECKOUT_RULES_ENABLED = 'true'  → on everywhere
 *   - ATTENDANCE_CHECKOUT_RULES_ENABLED = 'false' → off everywhere
 *   - unset → default by VERCEL_ENV: ON in preview/development, OFF in production
 */
export function checkoutRulesEnabled(businessId: string): boolean {
  if (businessId !== CHECKOUT_RULES_BUSINESS) return false
  const explicit = (process.env.ATTENDANCE_CHECKOUT_RULES_ENABLED || '').trim().toLowerCase()
  if (explicit === 'true') return true
  if (explicit === 'false') return false
  // Default: safe in production (off), live for testing on preview/dev.
  return process.env.VERCEL_ENV !== 'production'
}

/**
 * Hard time-block switch (Option A). UNLIKE checkoutRulesEnabled, this is ALWAYS
 * on for ALMA_LIFESTYLE in every environment — production, preview, dev, every
 * platform (Android, iPhone/Safari, web). The owner's rule "no checkout before
 * 8:00 PM" must be enforced server-side regardless of the location/task
 * kill-switch, because the previous gate (behind checkoutRulesEnabled) defaulted
 * OFF in production and let Safari users slip out early.
 *
 * Owner-approved exceptions and leave still waive the block (handled inside
 * runCheckoutGates).
 */
export function checkoutTimeBlockEnabled(businessId: string): boolean {
  return businessId === CHECKOUT_RULES_BUSINESS
}

export type CheckoutGateResult =
  | { ok: true }
  | { ok: false; code: 'checkout_too_early'; message: string; meta: { officeEndMinutes: number; nowMinutes: number } }
  | { ok: false; code: 'location_required'; message: string }
  | { ok: false; code: 'location_mismatch'; message: string; meta: { distanceM: number; radiusM: number } }
  | {
      ok: false
      code: 'tasks_incomplete'
      message: string
      meta: { tasksTotal: number; tasksDone: number; completionPct: number }
    }

/**
 * Gate 1 — no checkout before office end time (8:00 PM for ALMA_LIFESTYLE).
 * The owner can override per-staff later via the exception button (Step 3).
 */
export function checkoutTimeGate(businessId: string, now = new Date()): CheckoutGateResult {
  const { endMinutes } = officeHoursFor(businessId)
  const nowMinutes = localMinutesFor(now)
  if (nowMinutes < endMinutes) {
    const hh = Math.floor(endMinutes / 60)
    const mm = endMinutes % 60
    const label = `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`
    return {
      ok: false,
      code: 'checkout_too_early',
      message: `অফিস শেষের সময় (${label}) এর আগে চেক-আউট করা যাবে না। আগে বের হতে হলে মালিকের কাছ থেকে অনুমতি (exception) নিন।`,
      meta: { officeEndMinutes: endMinutes, nowMinutes },
    }
  }
  return { ok: true }
}

/**
 * Gate 2 — checkout must be from inside the office geofence (same rule as
 * check-in). If the office location isn't configured, we skip silently so the
 * feature never hard-blocks staff due to missing env config.
 */
type CheckoutLocation = { latitude?: number | null; longitude?: number | null } | null | undefined

export function checkoutLocationGate(
  businessId: string,
  location: CheckoutLocation,
): CheckoutGateResult {
  const office = officeLocationFor(businessId)
  if (!office) return { ok: true } // office geofence not configured → don't block
  const lat = location?.latitude
  const lng = location?.longitude
  if (lat == null || lng == null) {
    return {
      ok: false,
      code: 'location_required',
      message: 'চেক-আউট করতে লোকেশন (GPS) চালু থাকতে হবে। অনুগ্রহ করে লোকেশন অনুমতি দিন এবং আবার চেষ্টা করুন।',
    }
  }
  const distanceM = distanceMeters({ latitude: lat, longitude: lng }, office)
  if (distanceM > office.radiusM) {
    const km = (distanceM / 1000).toFixed(distanceM >= 1000 ? 1 : 2)
    return {
      ok: false,
      code: 'location_mismatch',
      message: `আপনি অফিস থেকে ~${km} কিমি দূরে আছেন। অফিসের ভেতর থেকে চেক-আউট করুন। মাঠের কাজ হলে মালিকের কাছ থেকে অনুমতি (exception) নিন।`,
      meta: { distanceM, radiusM: office.radiusM },
    }
  }
  return { ok: true }
}

/**
 * Gate 3 — if the staff has tasks assigned for today, at least 75% must be
 * done before checkout. No tasks today → normal checkout (gate passes).
 *
 * Link: AttendanceRecord.userId (a User cuid) == AgentStaff.userId. We resolve
 * the AgentStaff row from the checking-out user, then count today's tasks.
 */
export async function checkoutTaskGate(
  userId: string | null | undefined,
  businessId: string,
  attendanceDate: Date,
): Promise<CheckoutGateResult> {
  if (!userId) return { ok: true }
  const staff = await prisma.agentStaff.findFirst({
    where: { userId, businessId },
    select: { id: true },
  })
  if (!staff) return { ok: true } // no staff profile → no tasks to gate on

  const tasks = await prisma.agentStaffTask.findMany({
    where: { staffId: staff.id, businessId, proposedFor: attendanceDate },
    select: { status: true },
  })
  const assigned = tasks.filter(t => !NON_ASSIGNED_TASK_STATUSES.has(t.status))
  const tasksTotal = assigned.length
  if (tasksTotal === 0) return { ok: true }

  const tasksDone = assigned.filter(t => DONE_TASK_STATUSES.has(t.status)).length
  const completionPct = Math.round((tasksDone / tasksTotal) * 100)
  if (tasksDone / tasksTotal < CHECKOUT_TASK_THRESHOLD) {
    return {
      ok: false,
      code: 'tasks_incomplete',
      message: `আজকের কাজ ${completionPct}% শেষ হয়েছে (${tasksDone}/${tasksTotal})। চেক-আউট করতে অন্তত ৭৫% কাজ শেষ করতে হবে।`,
      meta: { tasksTotal, tasksDone, completionPct },
    }
  }
  return { ok: true }
}

/**
 * Run all three gates in order (time → location → task) and return the first
 * failure. Caller must have already confirmed checkoutRulesEnabled(businessId).
 */
export async function runCheckoutGates(input: {
  businessId: string
  userId: string | null | undefined
  attendanceDate: Date
  now?: Date
  location: CheckoutLocation
  // When false, only the always-on time block runs (location + task gates are
  // skipped). The check-out route passes the kill-switch state here so the 8 PM
  // block is enforced in production while location/task gates stay gated.
  enforceExtraGates?: boolean
}): Promise<CheckoutGateResult> {
  const now = input.now ?? new Date()
  const enforceExtra = input.enforceExtraGates ?? true
  // Step 3 — an owner-approved exception waives ALL gates for this staff today
  // (whole-day, or within the granted hour window).
  if (await hasApprovedException(input.userId, input.businessId, input.attendanceDate, now)) {
    return { ok: true }
  }
  // Step 4 — an owner-approved leave covering today also waives ALL gates
  // (whole-day/range leave always; hour/shifted-start leave within its window).
  if (await leaveWaivesCheckout(input.userId, input.businessId, input.attendanceDate, now)) {
    return { ok: true }
  }
  const timeGate = checkoutTimeGate(input.businessId, now)
  if (!timeGate.ok) return timeGate
  if (!enforceExtra) return { ok: true }
  const locationGate = checkoutLocationGate(input.businessId, input.location)
  if (!locationGate.ok) return locationGate
  return checkoutTaskGate(input.userId, input.businessId, input.attendanceDate)
}
