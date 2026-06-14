import { prisma } from '@/lib/prisma'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { createOrUpdateAgentMemory } from '@/agent/lib/agent-memory'
import { fetchOutcomeMetric } from '@/lib/outcome-metrics'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type OutcomeJudgment = 'worked' | 'no_effect' | 'worse' | 'inconclusive'

function judgeMetric(
  metric: string,
  baseline: number | null,
  actual: number | null,
  ownerActioned: boolean,
): OutcomeJudgment {
  if (actual == null) return 'inconclusive'
  if (!ownerActioned) return 'inconclusive'

  if (metric === 'winback_return_14d') {
    const cohort = baseline ?? 0
    if (actual >= Math.max(1, Math.ceil(cohort * 0.1))) return 'worked'
    if (actual > 0) return 'no_effect'
    return 'no_effect'
  }

  if (baseline == null) return 'inconclusive'

  const ratio = baseline > 0 ? actual / baseline : actual > 0 ? 2 : 1
  if (ratio >= 1.1) return 'worked'
  if (ratio <= 0.9) return 'worse'
  return 'no_effect'
}

function deriveLearning(
  outcome: {
    type: string
    subjectName?: string | null
    metric: string
    baselineValue: number | null
    actualValue: number
    result: OutcomeJudgment
    ownerActioned: boolean
  },
): string {
  const name = outcome.subjectName || 'এই বিষয়ে'
  if (!outcome.ownerActioned) {
    return `${name}: পরিমাপ হয়েছে (${outcome.actualValue} vs baseline ${outcome.baselineValue ?? '—'}) — owner action confirm না হওয়ায় causation বলা যায় না।`
  }

  const assoc = 'সংযুক্তভাবে দেখা গেছে (causation নয়)'
  switch (outcome.result) {
    case 'worked':
      if (outcome.type === 'reorder' || outcome.type === 'content') {
        return `${name}-এ পরামর্শের পর বিক্রি বেড়েছে ${assoc} — ${outcome.baselineValue ?? 0} → ${outcome.actualValue} (${outcome.metric})।`
      }
      if (outcome.type === 'winback') {
        return `Win-back cohort-এ ${outcome.actualValue} জন ফিরে এসেছে ${assoc}।`
      }
      if (outcome.type === 'ad_boost') {
        return `Ad boost পরামর্শের পর ৭ দিনের সেল ${outcome.baselineValue ?? 0} → ${outcome.actualValue} ${assoc}।`
      }
      return `${name}: মেট্রিক উন্নতি ${assoc} (${outcome.baselineValue ?? 0} → ${outcome.actualValue})।`
    case 'worse':
      return `${name}: মেট্রিক কমেছে ${assoc} (${outcome.baselineValue ?? 0} → ${outcome.actualValue}) — ভবিষ্যতে সতর্ক থাকুন।`
    case 'no_effect':
      return `${name}: পরামর্শের পর মেট্রিক প্রায় একই ${assoc} (${outcome.baselineValue ?? 0} → ${outcome.actualValue})।`
    default:
      return `${name}: ডেটা অপর্যাপ্ত — ফলাফল inconclusive।`
  }
}

async function saveOutcomeLearning(
  outcome: { type: string; learning: string },
) {
  const key = `outcome_${outcome.type}_${todayYmdDhaka()}`
  await createOrUpdateAgentMemory({
    scope: 'business',
    key,
    content: outcome.learning,
    pinned: false,
    metadata: {
      type: 'outcome_learning',
      suggestionType: outcome.type,
      date: todayYmdDhaka(),
    },
  })
}

export async function measurePendingOutcomes(): Promise<{ measured: number; errors: string[] }> {
  const today = todayYmdDhaka()
  const errors: string[] = []
  let measured = 0

  const pending = await db.agentOutcome.findMany({
    where: {
      status: 'pending',
      measureAfter: { lte: today },
    },
    orderBy: { measureAfter: 'asc' },
    take: 50,
  }) as Array<{
    id: string
    type: string
    subjectKind: string
    subjectId: string | null
    subjectName: string | null
    suggestion: string
    rationale: string | null
    metric: string
    baselineValue: number | null
    predicted: string | null
    ownerActioned: boolean
    createdAt: Date
  }>

  for (const row of pending) {
    try {
      const { value, note } = await fetchOutcomeMetric(row.metric, row)
      if (value == null) {
        await db.agentOutcome.update({
          where: { id: row.id },
          data: {
            status: 'inconclusive',
            result: 'inconclusive',
            learning: note ?? 'মেট্রিক মাপা যায়নি — ডেটা অপর্যাপ্ত।',
            measuredAt: new Date(),
          },
        })
        measured++
        continue
      }

      const result = judgeMetric(row.metric, row.baselineValue, value, row.ownerActioned)
      const learning = deriveLearning({
        type: row.type,
        subjectName: row.subjectName,
        metric: row.metric,
        baselineValue: row.baselineValue,
        actualValue: value,
        result,
        ownerActioned: row.ownerActioned,
      })

      await db.agentOutcome.update({
        where: { id: row.id },
        data: {
          status: result === 'inconclusive' ? 'inconclusive' : 'measured',
          actualValue: value,
          result,
          learning,
          measuredAt: new Date(),
        },
      })

      if (learning) await saveOutcomeLearning({ type: row.type, learning })
      measured++
    } catch (e) {
      errors.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return { measured, errors }
}

export async function buildOutcomeScorecard(days = 7): Promise<string> {
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = await db.agentOutcome.findMany({
    where: {
      measuredAt: { gte: since },
      status: { in: ['measured', 'inconclusive'] },
    },
    orderBy: { measuredAt: 'desc' },
  }) as Array<{
    type: string
    result: string | null
    learning: string | null
    subjectName: string | null
  }>

  if (!rows.length) {
    return '📈 *গত সপ্তাহের পরামর্শের ফলাফল:*\n• এখনো কোনো matured outcome নেই — পরামর্শ track হচ্ছে।'
  }

  const byType = new Map<string, { worked: number; noEffect: number; worse: number; inconclusive: number; learnings: string[] }>()
  for (const r of rows) {
    const t = byType.get(r.type) ?? { worked: 0, noEffect: 0, worse: 0, inconclusive: 0, learnings: [] }
    if (r.result === 'worked') t.worked++
    else if (r.result === 'worse') t.worse++
    else if (r.result === 'no_effect') t.noEffect++
    else t.inconclusive++
    if (r.learning && t.learnings.length < 2) t.learnings.push(r.learning)
    byType.set(r.type, t)
  }

  const TYPE_LABELS: Record<string, string> = {
    reorder: 'Reorder',
    ad_boost: 'Ad boost',
    content: 'Content',
    winback: 'Win-back',
    pricing: 'Pricing',
  }

  const lines = ['📈 *গত সপ্তাহের পরামর্শের ফলাফল (সংযুক্তি, causation নয়):*']
  for (const [type, stats] of byType) {
    const label = TYPE_LABELS[type] ?? type
    const total = stats.worked + stats.noEffect + stats.worse + stats.inconclusive
    const parts = [
      stats.worked ? `${stats.worked}টি worked` : null,
      stats.noEffect ? `${stats.noEffect}টি no effect` : null,
      stats.worse ? `${stats.worse}টি worse` : null,
      stats.inconclusive ? `${stats.inconclusive}টি inconclusive` : null,
    ].filter(Boolean)
    lines.push(`• ${label} (${total}টি): ${parts.join(', ')}`)
    for (const l of stats.learnings.slice(0, 1)) {
      lines.push(`  ↳ ${l}`)
    }
  }

  const topLearning = rows.find((r) => r.result === 'worked' && r.learning)?.learning
  if (topLearning) {
    lines.push(`\nশিখলাম: ${topLearning}`)
  }

  return lines.join('\n')
}
