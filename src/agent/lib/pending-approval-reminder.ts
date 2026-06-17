/**
 * Phase C — prepend pending-approval reminder on every owner interaction.
 */
import { prisma } from '@/lib/prisma'

function titleFromSummary(summary: string): string {
  const line = summary.replace(/\n/g, ' ').trim()
  const quoted = line.match(/"([^"]+)"/)
  if (quoted?.[1]) return quoted[1].slice(0, 120)
  return line.slice(0, 120)
}

function titleFromPendingRow(row: {
  type: string
  summary: string
  payload: unknown
}): string {
  const payload = row.payload && typeof row.payload === 'object'
    ? (row.payload as Record<string, unknown>)
    : {}
  if (row.type === 'duty_approval_block' && typeof payload.dutyLabel === 'string') {
    return payload.dutyLabel.slice(0, 120)
  }
  if (typeof payload.dutyLabel === 'string') return payload.dutyLabel.slice(0, 120)
  return titleFromSummary(row.summary)
}

/** One line per item (max 2), empty string if none pending. */
export async function buildPendingApprovalReminderPrefix(): Promise<string> {
  const rows = await prisma.agentPendingAction.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: 10,
    select: { type: true, summary: true, payload: true },
  })

  if (rows.length === 0) return ''

  const titles = rows.slice(0, 2).map(titleFromPendingRow)
  const lines = titles.map(
    (title) => `🔔 Sir, মনে করিয়ে দিই — "${title}" এখনো approval-এর অপেক্ষায়।`,
  )
  return `${lines.join('\n')}\n\n`
}
