/**
 * "Performer of the Week" — auto-scoring + owner override.
 *
 * Auto score (current Dhaka week) per staff:
 *   done task            +10
 *   owner-approved proof  +5  (quality signal on top of done)
 *   self-initiated, approved +8 (initiative)
 *   redo requested        -3  (rework)
 * The top score wins; ties break on most-recent completion. The owner can pin
 * any staff member, which sets pinnedByOwner=true and freezes the auto pick.
 */
import { prisma } from '@/lib/prisma'

const DONE_PTS = 10
const APPROVED_PTS = 5
const SELF_PTS = 8
const REDO_PTS = -3

export type StaffScore = { staffId: string; staffName: string; score: number; done: number; lastDoneAt: number }

/** Monday 00:00 UTC anchoring the current Dhaka week. */
export function currentWeekStart(): Date {
  const dhaka = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }))
  const dow = dhaka.getDay() // 0=Sun..6=Sat
  const diff = (dow + 6) % 7 // days since Monday
  const monday = new Date(dhaka)
  monday.setDate(dhaka.getDate() - diff)
  const ymd = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`
  return new Date(`${ymd}T00:00:00Z`)
}

export async function computeWeeklyScores(businessId: string, weekStart = currentWeekStart()): Promise<StaffScore[]> {
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000)

  const tasks = await prisma.agentStaffTask.findMany({
    where: { businessId, proposedFor: { gte: weekStart, lt: weekEnd } },
    select: {
      staffId: true,
      status: true,
      verificationStatus: true,
      source: true,
      redoCount: true,
      completedAt: true,
      staff: { select: { name: true } },
    },
  })

  const map = new Map<string, StaffScore>()
  for (const t of tasks) {
    const entry = map.get(t.staffId) ?? {
      staffId: t.staffId,
      staffName: t.staff?.name ?? 'অজানা',
      score: 0,
      done: 0,
      lastDoneAt: 0,
    }
    if (t.status === 'done') {
      entry.score += DONE_PTS
      entry.done += 1
      if (t.completedAt) entry.lastDoneAt = Math.max(entry.lastDoneAt, t.completedAt.getTime())
    }
    if (t.verificationStatus === 'owner_approved') entry.score += APPROVED_PTS
    if (t.source === 'staff_initiated' && t.status === 'done') entry.score += SELF_PTS
    entry.score += (t.redoCount ?? 0) * REDO_PTS
    map.set(t.staffId, entry)
  }

  return [...map.values()].sort((a, b) => b.score - a.score || b.lastDoneAt - a.lastDoneAt)
}

// ── P3: contextual award scoring ────────────────────────────────────────────
//
// The flat weekly score above rewards raw volume. Contextual scoring layers
// *context* bonuses on top so the award reflects more than "who did the most":
//   • momentum  — finishing more than last week (improvement is rewarded)
//   • clean     — a real week of work with zero rework (quality)
//   • punctual  — every deadline met (reliability)
// These are additive and never go negative, so they can only lift a deserving
// staffer — they never punish. The winner is picked on base + context bonus.

const IMPROVE_BONUS = 5
const CLEAN_BONUS = 6
const PUNCTUAL_BONUS = 5

export type ContextualScore = StaffScore & {
  /** The flat volume score (same as computeWeeklyScores). */
  baseScore: number
  /** Sum of the context bonuses applied. */
  bonus: number
  /** Bangla reasons for each bonus, for the owner-facing standings. */
  reasons: string[]
}

/**
 * Weekly scores with context bonuses layered on. `score` is base + bonus (so it
 * stays a drop-in for award selection); `baseScore` keeps the flat volume value.
 */
export async function computeContextualScores(
  businessId: string,
  weekStart = currentWeekStart(),
): Promise<ContextualScore[]> {
  const prevStart = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000)
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000)

  const [base, prevBase, rows] = await Promise.all([
    computeWeeklyScores(businessId, weekStart),
    computeWeeklyScores(businessId, prevStart),
    prisma.agentStaffTask.findMany({
      where: { businessId, proposedFor: { gte: weekStart, lt: weekEnd } },
      select: { staffId: true, status: true, redoCount: true, dueAt: true, completedAt: true },
    }),
  ])

  const prevDone = new Map(prevBase.map((s) => [s.staffId, s.done]))

  // Per-staff this-week context: total redo, and on-time vs late among tasks
  // that actually had a deadline.
  type Ctx = { redo: number; onTime: number; withDue: number }
  const ctx = new Map<string, Ctx>()
  for (const t of rows) {
    const c = ctx.get(t.staffId) ?? { redo: 0, onTime: 0, withDue: 0 }
    c.redo += t.redoCount ?? 0
    if (t.status === 'done' && t.dueAt && t.completedAt) {
      c.withDue += 1
      if (t.completedAt.getTime() <= t.dueAt.getTime()) c.onTime += 1
    }
    ctx.set(t.staffId, c)
  }

  return base
    .map((s) => {
      const c = ctx.get(s.staffId) ?? { redo: 0, onTime: 0, withDue: 0 }
      const reasons: string[] = []
      let bonus = 0

      const prev = prevDone.get(s.staffId) ?? 0
      if (s.done > prev && s.done > 0) {
        bonus += IMPROVE_BONUS
        reasons.push(`📈 গত সপ্তাহের চেয়ে বেশি কাজ (+${IMPROVE_BONUS})`)
      }
      if (c.redo === 0 && s.done >= 3) {
        bonus += CLEAN_BONUS
        reasons.push(`✨ একবারও redo ছাড়া পরিষ্কার সপ্তাহ (+${CLEAN_BONUS})`)
      }
      if (c.withDue >= 2 && c.onTime === c.withDue) {
        bonus += PUNCTUAL_BONUS
        reasons.push(`⏰ সব deadline সময়মতো (+${PUNCTUAL_BONUS})`)
      }

      return { ...s, baseScore: s.score, bonus, reasons, score: s.score + bonus }
    })
    .sort((a, b) => b.score - a.score || b.lastDoneAt - a.lastDoneAt)
}

/** Recompute and store the auto winner for the current week (skips if owner-pinned). */
export async function recomputeWeeklyAward(businessId: string): Promise<{ winner: ContextualScore | null; pinned: boolean }> {
  const weekStart = currentWeekStart()
  const existing = await prisma.officeWeeklyAward.findUnique({
    where: { businessId_weekStart: { businessId, weekStart } },
    select: { pinnedByOwner: true },
  })
  if (existing?.pinnedByOwner) {
    return { winner: null, pinned: true }
  }

  const scores = await computeContextualScores(businessId, weekStart)
  const winner = scores.find((s) => s.score > 0) ?? null
  if (!winner) return { winner: null, pinned: false }

  await prisma.officeWeeklyAward.upsert({
    where: { businessId_weekStart: { businessId, weekStart } },
    create: { businessId, weekStart, staffId: winner.staffId, score: winner.score, auto: true, pinnedByOwner: false },
    update: { staffId: winner.staffId, score: winner.score, auto: true, pinnedByOwner: false },
  })
  return { winner, pinned: false }
}

/** Owner pins a specific staff member as the week's winner (overrides auto). */
export async function pinWeeklyAward(
  businessId: string,
  staffId: string,
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const weekStart = currentWeekStart()
  const staff = await prisma.agentStaff.findFirst({ where: { id: staffId, businessId }, select: { id: true } })
  if (!staff) return { ok: false, error: 'staff_not_found' }

  const scores = await computeWeeklyScores(businessId, weekStart)
  const score = scores.find((s) => s.staffId === staffId)?.score ?? 0

  await prisma.officeWeeklyAward.upsert({
    where: { businessId_weekStart: { businessId, weekStart } },
    create: { businessId, weekStart, staffId, score, auto: false, pinnedByOwner: true, note: note?.trim() || null },
    update: { staffId, score, auto: false, pinnedByOwner: true, note: note?.trim() || null },
  })
  return { ok: true }
}

/** Owner clears the pin, reverting to auto scoring. */
export async function clearWeeklyAwardPin(businessId: string): Promise<void> {
  const weekStart = currentWeekStart()
  await prisma.officeWeeklyAward.updateMany({
    where: { businessId, weekStart },
    data: { pinnedByOwner: false, auto: true, note: null },
  })
  await recomputeWeeklyAward(businessId)
}
