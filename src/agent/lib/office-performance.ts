/**
 * Staff performance scorecard (Phase 3).
 *
 * A per-staff rollup over the current Dhaka week, built entirely from existing
 * task data + the supervisor's audit fields — no new tracking. It tells the
 * owner, at a glance, who is reliable: how much they finished, how punctual they
 * are vs. their deadlines, how often work bounced back (redo), and how often the
 * supervisor had to escalate to him. Read-only; safe to call on every page load.
 */
import { prisma } from '@/lib/prisma'
import { computeWeeklyScores, currentWeekStart } from '@/agent/lib/office-award'

export type StaffPerformance = {
  staffId: string
  staffName: string
  assigned: number
  done: number
  /** Finished on or before the deadline (only counts tasks that had a deadline). */
  onTime: number
  /** Finished after the deadline. */
  late: number
  /** On-time % over tasks that had a deadline (0–100), or null if none had one. */
  onTimeRate: number | null
  /** Total redo rounds across the staff's tasks this week (rework signal). */
  redo: number
  /** Tasks the supervisor had to hand to the owner (the ~10%). */
  escalated: number
  /** Tasks the supervisor confidently auto-verified. */
  autoVerified: number
  /** Low-stakes tasks accepted without full verification (90/10 gate). */
  accepted: number
  /** Composite weekly score (shared with Performer of the Week). */
  score: number
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** Compute the per-staff performance scorecard for the current (or given) Dhaka week. */
export async function computeStaffPerformance(
  businessId = 'ALMA_LIFESTYLE',
  weekStart: Date = currentWeekStart(),
): Promise<StaffPerformance[]> {
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000)

  const [rows, scores] = await Promise.all([
    prisma.agentStaffTask.findMany({
      where: { businessId, proposedFor: { gte: weekStart, lt: weekEnd } },
      select: {
        staffId: true,
        status: true,
        verificationStatus: true,
        redoCount: true,
        dueAt: true,
        completedAt: true,
        supervisorNeedsOwner: true,
        escalatedAt: true,
        proofData: true,
        staff: { select: { name: true } },
      },
    }),
    computeWeeklyScores(businessId, weekStart),
  ])

  const scoreById = new Map(scores.map((s) => [s.staffId, s.score]))

  type Acc = Omit<StaffPerformance, 'onTimeRate' | 'score'>
  const map = new Map<string, Acc>()
  for (const t of rows) {
    const acc =
      map.get(t.staffId) ??
      ({
        staffId: t.staffId,
        staffName: t.staff?.name ?? 'অজানা',
        assigned: 0,
        done: 0,
        onTime: 0,
        late: 0,
        redo: 0,
        escalated: 0,
        autoVerified: 0,
        accepted: 0,
      } as Acc)

    acc.assigned += 1
    acc.redo += t.redoCount ?? 0
    if (t.supervisorNeedsOwner || t.escalatedAt) acc.escalated += 1

    if (t.status === 'done') {
      acc.done += 1
      if (t.dueAt && t.completedAt) {
        if (t.completedAt.getTime() <= t.dueAt.getTime()) acc.onTime += 1
        else acc.late += 1
      }
      if (t.verificationStatus === 'auto_verified') {
        const method = asRecord(t.proofData)?.agentMethod
        if (method === 'accepted_unverified') acc.accepted += 1
        else acc.autoVerified += 1
      }
    }
    map.set(t.staffId, acc)
  }

  return [...map.values()]
    .map((a) => {
      const withDue = a.onTime + a.late
      return {
        ...a,
        onTimeRate: withDue > 0 ? Math.round((a.onTime / withDue) * 100) : null,
        score: scoreById.get(a.staffId) ?? 0,
      }
    })
    .sort((x, y) => y.score - x.score || y.done - x.done)
}
