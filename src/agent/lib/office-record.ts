/**
 * Office "daily record" board — per-staff task-completion scoreboard.
 *
 * Computed entirely from existing `staff_tasks` rows (no new table). Shows, per
 * staff, how many of the day's assigned tasks were completed, plus week/month
 * rollups the owner reviews. Heavy artefacts (images, proofs, chat) stay in
 * Telegram — this is just the dated accountability summary.
 */
import { prisma } from '@/lib/prisma'

// A task counts toward the day's total once it has actually been dispatched to
// the staff member. "proposed" (owner hasn't approved) and "cancelled" never
// count. "done" is the completed bucket.
const DISPATCHED_STATUSES = ['sent', 'approved', 'carried', 'done'] as const

export type StaffDayStat = { date: string; done: number; total: number }

export type StaffRollup = {
  staffId: string
  name: string
  weekDone: number
  weekTotal: number
  monthDone: number
  monthTotal: number
  days: StaffDayStat[]
}

export type OfficeDailyRecord = {
  today: string
  weekDates: string[] // most-recent first, last 7 days incl. today
  staff: StaffRollup[] // only staff with at least one task this month
  hasData: boolean
}

/** Dhaka-local YYYY-MM-DD. */
function dhakaToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

/** Shift a YYYY-MM-DD string by whole days (UTC-anchored, safe for date keys). */
function shiftYmd(ymd: string, deltaDays: number): string {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}

function ymdOf(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export async function getOfficeDailyRecord(
  businessId = 'ALMA_LIFESTYLE',
): Promise<OfficeDailyRecord> {
  const today = dhakaToday()
  const weekStart = shiftYmd(today, -6) // 7-day window incl. today
  const monthStart = `${today.slice(0, 7)}-01`
  const fetchStart = weekStart < monthStart ? weekStart : monthStart

  const weekDates: string[] = []
  for (let i = 0; i < 7; i += 1) weekDates.push(shiftYmd(today, -i))

  const rows = await prisma.agentStaffTask.findMany({
    where: {
      businessId,
      proposedFor: {
        gte: new Date(`${fetchStart}T00:00:00Z`),
        lte: new Date(`${today}T00:00:00Z`),
      },
      status: { in: [...DISPATCHED_STATUSES] },
    },
    select: {
      staffId: true,
      proposedFor: true,
      status: true,
      staff: { select: { name: true } },
    },
  })

  const byStaff = new Map<string, StaffRollup & { dayMap: Map<string, StaffDayStat> }>()

  for (const r of rows) {
    const ymd = ymdOf(r.proposedFor)
    const isDone = r.status === 'done'

    let entry = byStaff.get(r.staffId)
    if (!entry) {
      entry = {
        staffId: r.staffId,
        name: r.staff?.name ?? 'অজানা',
        weekDone: 0,
        weekTotal: 0,
        monthDone: 0,
        monthTotal: 0,
        days: [],
        dayMap: new Map(),
      }
      byStaff.set(r.staffId, entry)
    }

    if (ymd >= monthStart) {
      entry.monthTotal += 1
      if (isDone) entry.monthDone += 1
    }
    if (ymd >= weekStart) {
      entry.weekTotal += 1
      if (isDone) entry.weekDone += 1

      let day = entry.dayMap.get(ymd)
      if (!day) {
        day = { date: ymd, done: 0, total: 0 }
        entry.dayMap.set(ymd, day)
      }
      day.total += 1
      if (isDone) day.done += 1
    }
  }

  const staff: StaffRollup[] = [...byStaff.values()]
    .map(({ dayMap, ...rest }) => ({
      ...rest,
      days: [...dayMap.values()].sort((a, b) => b.date.localeCompare(a.date)),
    }))
    .sort((a, b) => {
      // Most completed this week first, then by name.
      if (b.weekDone !== a.weekDone) return b.weekDone - a.weekDone
      return a.name.localeCompare(b.name)
    })

  return {
    today,
    weekDates,
    staff,
    hasData: staff.length > 0,
  }
}
