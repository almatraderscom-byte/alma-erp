import { prisma } from '@/lib/prisma'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type OutcomeType = 'reorder' | 'ad_boost' | 'content' | 'winback' | 'pricing' | 'staff_plan'

export type TrackOutcomeArgs = {
  type: OutcomeType | string
  subjectKind: string
  subjectId?: string
  subjectName?: string
  suggestion: string
  rationale?: string
  metric: string
  baselineValue?: number
  predicted?: string
  measureAfterDays: number
}

function measureAfterYmd(days: number): string {
  return new Date(Date.now() + days * 86_400_000)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

function dhakaDayStartUtc(ymd: string): Date {
  return new Date(`${ymd}T00:00:00+06:00`)
}

/**
 * Record a suggestion to measure later. Captures baseline at suggestion time.
 * Dedupes: one pending outcome per type+subject per Dhaka day.
 */
export async function trackOutcome(args: TrackOutcomeArgs) {
  const measureAfter = measureAfterYmd(args.measureAfterDays)
  const today = todayYmdDhaka()
  const dayStart = dhakaDayStartUtc(today)

  try {
    const existing = await db.agentOutcome.findFirst({
      where: {
        type: args.type,
        subjectKind: args.subjectKind,
        ...(args.subjectId ? { subjectId: args.subjectId } : {}),
        ...(args.subjectName ? { subjectName: args.subjectName } : {}),
        status: 'pending',
        createdAt: { gte: dayStart },
      },
      select: { id: true },
    })
    if (existing) return existing

    return await db.agentOutcome.create({
      data: {
        type: args.type,
        subjectKind: args.subjectKind,
        subjectId: args.subjectId ?? null,
        subjectName: args.subjectName ?? null,
        suggestion: args.suggestion,
        rationale: args.rationale ?? null,
        metric: args.metric,
        baselineValue: args.baselineValue ?? null,
        predicted: args.predicted ?? null,
        measureAfter,
      },
    })
  } catch {
    return null
  }
}

/** Mark that the owner actually acted — meaningful attribution only when true. */
export async function markOutcomeActioned(outcomeId: string) {
  try {
    await db.agentOutcome.update({
      where: { id: outcomeId },
      data: { ownerActioned: true },
    })
  } catch { /* non-fatal */ }
}

export async function getRecentOutcomeLearnings(opts: {
  type?: string
  limit?: number
} = {}) {
  const limit = Math.min(opts.limit ?? 6, 20)
  const rows = await db.agentMemory.findMany({
    where: { scope: 'business' },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { content: true, metadata: true, createdAt: true },
  }) as Array<{ content: string; metadata: Record<string, unknown> | null; createdAt: Date }>

  return rows
    .filter((r) => {
      const meta = r.metadata
      if (meta?.type !== 'outcome_learning') return false
      if (opts.type && meta.suggestionType !== opts.type) return false
      return true
    })
    .slice(0, limit)
}

export function formatOutcomeLearningsForPrompt(
  learnings: Array<{ content: string; metadata: Record<string, unknown> | null }>,
): string {
  if (!learnings.length) return ''
  const lines = learnings.map((l) => `• ${l.content}`)
  return `\n\n## RECENT OUTCOME LEARNINGS (correlation, not causation)\n${lines.join('\n')}`
}
