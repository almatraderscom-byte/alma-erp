/**
 * P5 weekly self-report — the agent's own QA loop (roadmap P5).
 *
 * Aggregates a week of terminal states into one owner digest:
 *   • every failure/pause CHECKPOINT written (what broke, resolved or still open),
 *   • success-rate telemetry per long-job type (executed vs failed),
 *   • task types below threshold get FLAGGED for playbook improvement —
 *     never silently retried harder (roadmap P5, last bullet).
 *
 * Consumed by /api/assistant/internal/self-report (worker cron fetches weekly
 * and pushes the Bangla digest to the owner).
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Long worker-job types covered by success telemetry (mirrors the P0 watchdog). */
export const TELEMETRY_JOB_TYPES = [
  'image_gen',
  'video_gen',
  'long_agent_task',
  'browser_action',
  'workbench_run',
  'outbound_call',
] as const

/** Below this success rate (with enough runs) a task type is flagged. */
export const FLAG_THRESHOLD = 0.8
export const FLAG_MIN_RUNS = 3

export type JobTypeStat = {
  type: string
  total: number
  executed: number
  failed: number
  pending: number
  successRate: number | null // null when nothing resolved yet
  flagged: boolean
}

export type CheckpointSummary = {
  taskType: string
  title: string
  state: 'open' | 'resolved'
  error: string | null
  at: string
}

export type WeeklySelfReport = {
  days: number
  from: string
  to: string
  checkpoints: { total: number; stillOpen: number; items: CheckpointSummary[] }
  jobStats: JobTypeStat[]
  flaggedTypes: string[]
  digestBn: string
}

export async function buildWeeklySelfReport(days = 7): Promise<WeeklySelfReport> {
  const now = new Date()
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

  // 1. Checkpoints written in the window (open + resolved), newest first.
  const cpRows = await db.agentOpenTask.findMany({
    where: {
      kind: { in: ['checkpoint_failed', 'checkpoint_waiting'] },
      createdAt: { gte: from },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { title: true, status: true, checkpoint: true, createdAt: true },
  })
  type CpRow = { title: string; status: string; checkpoint: unknown; createdAt: Date }
  const checkpoints: CheckpointSummary[] = (cpRows as CpRow[]).map((r) => {
    const cp = (r.checkpoint ?? {}) as { taskType?: string; error?: string }
    return {
      taskType: cp.taskType ?? 'unknown',
      title: r.title,
      state: r.status === 'open' || r.status === 'running' ? 'open' : 'resolved',
      error: cp.error ?? null,
      at: r.createdAt.toISOString(),
    }
  })
  const stillOpen = checkpoints.filter((c) => c.state === 'open').length

  // 2. Success telemetry per job type.
  const jobRows = await db.agentPendingAction.findMany({
    where: { type: { in: [...TELEMETRY_JOB_TYPES] }, createdAt: { gte: from } },
    select: { type: true, status: true },
  })
  type JobRow = { type: string; status: string }
  const byType = new Map<string, { total: number; executed: number; failed: number; pending: number }>()
  for (const row of jobRows as JobRow[]) {
    const s = byType.get(row.type) ?? { total: 0, executed: 0, failed: 0, pending: 0 }
    s.total++
    if (row.status === 'executed') s.executed++
    else if (row.status === 'failed') s.failed++
    else s.pending++
    byType.set(row.type, s)
  }
  const jobStats: JobTypeStat[] = [...byType.entries()]
    .map(([type, s]) => {
      const resolved = s.executed + s.failed
      const successRate = resolved > 0 ? s.executed / resolved : null
      return {
        type,
        ...s,
        successRate,
        flagged: resolved >= FLAG_MIN_RUNS && successRate !== null && successRate < FLAG_THRESHOLD,
      }
    })
    .sort((a, b) => b.total - a.total)
  const flaggedTypes = jobStats.filter((s) => s.flagged).map((s) => s.type)

  const report: WeeklySelfReport = {
    days,
    from: from.toISOString(),
    to: now.toISOString(),
    checkpoints: { total: checkpoints.length, stillOpen, items: checkpoints },
    jobStats,
    flaggedTypes,
    digestBn: '',
  }
  report.digestBn = formatSelfReportBn(report)
  return report
}

/** Owner-facing Bangla digest (Telegram/native push friendly, compact). */
export function formatSelfReportBn(r: WeeklySelfReport): string {
  const lines: string[] = [
    '🧾 সাপ্তাহিক সেলফ-রিপোর্ট (agent QA)',
    `📅 গত ${r.days} দিন`,
    '',
    `⛔ Checkpoint লেখা হয়েছে: ${r.checkpoints.total}টা (এখনো খোলা: ${r.checkpoints.stillOpen})`,
  ]
  for (const c of r.checkpoints.items.slice(0, 5)) {
    lines.push(`  • [${c.state === 'open' ? 'খোলা' : 'মিটেছে'}] ${c.title.slice(0, 70)}`)
  }
  if (r.checkpoints.total > 5) lines.push(`  … আরো ${r.checkpoints.total - 5}টা`)
  lines.push('')
  if (r.jobStats.length === 0) {
    lines.push('🔧 এই সপ্তাহে কোনো লম্বা কাজ চলেনি।')
  } else {
    lines.push('🔧 কাজের সাফল্যের হার:')
    for (const s of r.jobStats) {
      const rate = s.successRate === null ? '—' : `${Math.round(s.successRate * 100)}%`
      lines.push(`  • ${s.type}: ${s.executed}/${s.executed + s.failed} সফল (${rate})${s.flagged ? ' ⚠️' : ''}`)
    }
  }
  if (r.flaggedTypes.length) {
    lines.push('')
    lines.push(
      `⚠️ দুর্বল কাজের ধরন: ${r.flaggedTypes.join(', ')} — playbook/রেসিপি উন্নত করা দরকার (জোরে-জোরে retry নয়)।`,
    )
  }
  return lines.join('\n')
}
