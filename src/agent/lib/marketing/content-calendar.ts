/**
 * Phase 44 — content-calendar operations on top of AgentContentCalendar:
 * conflict detection, health (stale drafts / past-due approved / failures),
 * and recovery suggestions. Read-only over the calendar; scheduling itself
 * stays in growth-tools (approval-carded).
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export interface CalendarRowLite {
  id: string
  platform: string
  pageRef: string
  scheduledFor: Date
  status: string
  error?: string | null
}

export interface CalendarConflict {
  a: string
  b: string
  detail: string
}

/** Two posts on the same page within `windowMinutes` compete for reach — flag them. */
export function findCalendarConflicts(rows: CalendarRowLite[], windowMinutes = 90): CalendarConflict[] {
  const conflicts: CalendarConflict[] = []
  // Group per platform+page first — a post on another page in between must
  // not hide a same-page collision.
  const groups = new Map<string, CalendarRowLite[]>()
  for (const r of rows) {
    if (r.status !== 'draft' && r.status !== 'approved') continue
    const key = `${r.platform}/${r.pageRef}`
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  }
  for (const [key, list] of groups) {
    list.sort((x, y) => x.scheduledFor.getTime() - y.scheduledFor.getTime())
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i]
      const b = list[i + 1]
      const gapMin = (b.scheduledFor.getTime() - a.scheduledFor.getTime()) / 60000
      if (gapMin < windowMinutes) {
        conflicts.push({
          a: a.id,
          b: b.id,
          detail: `${key}: two posts ${Math.round(gapMin)} min apart (< ${windowMinutes})`,
        })
      }
    }
  }
  return conflicts
}

export interface CalendarHealth {
  staleDrafts: number
  pastDueApproved: number
  failed: Array<{ id: string; error: string | null; scheduledFor: Date }>
  conflicts: CalendarConflict[]
  advice: string[]
}

/** Pure health assessment over calendar rows (now injected for tests). */
export function assessCalendarHealth(rows: CalendarRowLite[], now: Date, windowMinutes = 90): CalendarHealth {
  const staleDrafts = rows.filter(
    (r) => r.status === 'draft' && r.scheduledFor.getTime() < now.getTime(),
  ).length
  const pastDueApproved = rows.filter(
    (r) => r.status === 'approved' && r.scheduledFor.getTime() < now.getTime() - 30 * 60000,
  ).length
  const failed = rows
    .filter((r) => r.status === 'failed')
    .map((r) => ({ id: r.id, error: r.error ?? null, scheduledFor: r.scheduledFor }))
  const conflicts = findCalendarConflicts(rows, windowMinutes)

  const advice: string[] = []
  if (staleDrafts > 0) advice.push(`${staleDrafts} draft(s) already past their slot — approve, reschedule, or cancel.`)
  if (pastDueApproved > 0) advice.push(`${pastDueApproved} approved post(s) past due >30min — the publish cron may be stuck; check worker/growth-publish.`)
  if (failed.length > 0) advice.push(`${failed.length} failed post(s) — inspect errors (token expiry / media processing) and reschedule after fixing.`)
  if (conflicts.length > 0) advice.push(`${conflicts.length} timing conflict(s) — same page posts too close together cannibalize reach.`)

  return { staleDrafts, pastDueApproved, failed, conflicts, advice }
}

/** Live calendar health over the next/last 14 days. */
export async function getCalendarHealth(businessId = 'ALMA_LIFESTYLE'): Promise<CalendarHealth> {
  const rows = (await db.agentContentCalendar.findMany({
    where: {
      businessId,
      scheduledFor: {
        gte: new Date(Date.now() - 14 * 86400000),
        lte: new Date(Date.now() + 14 * 86400000),
      },
    },
    select: { id: true, platform: true, pageRef: true, scheduledFor: true, status: true, error: true },
  })) as CalendarRowLite[]
  return assessCalendarHealth(rows, new Date())
}
