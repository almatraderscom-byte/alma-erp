import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type HealthIssue = {
  severity: 'high' | 'medium' | 'low'
  area: string
  title: string
  detail: string
  signal: string
}

export type HealthScanReport = {
  scannedAt: string
  ok: boolean
  issues: HealthIssue[]
  summary: string
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const

export async function runHealthScan(dateYmd?: string): Promise<HealthScanReport> {
  const ymd = dateYmd ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  const issues: HealthIssue[] = []

  try {
    const duties = await db.agentDutyLog.findMany({ where: { dutyDate: ymd } })
    for (const d of duties) {
      if (d.status === 'failed') {
        issues.push({
          severity: 'high',
          area: 'scheduler',
          title: `ডিউটি ব্যর্থ: ${d.label}`,
          detail: d.detail ?? '(কোনো বিস্তারিত নেই)',
          signal: `AgentDutyLog duty=${d.duty}`,
        })
      } else if (d.status === 'missed') {
        issues.push({
          severity: 'medium',
          area: 'scheduler',
          title: `ডিউটি মিস হয়েছে: ${d.label}`,
          detail: d.detail ?? '',
          signal: `AgentDutyLog duty=${d.duty}`,
        })
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000)
    const beats = await db.agentHeartbeat.findMany()
    for (const b of beats) {
      const last = b.lastBeatAt ?? b.updatedAt ?? b.createdAt
      if (last && new Date(last) < cutoff) {
        issues.push({
          severity: 'high',
          area: 'heartbeat',
          title: `Heartbeat থেমে গেছে: ${b.service}`,
          detail: `শেষ beat: ${new Date(last).toISOString()}`,
          signal: `AgentHeartbeat service=${b.service}`,
        })
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const events = await db.agentCostEvent.findMany({
      where: { occurredAt: { gte: since } },
      select: { provider: true, costUsd: true },
    })
    const byProvider: Record<string, number> = {}
    for (const e of events) {
      const prov = String(e.provider ?? 'unknown')
      byProvider[prov] = (byProvider[prov] ?? 0) + (Number(e.costUsd) || 0)
    }
    for (const [prov, usd] of Object.entries(byProvider)) {
      if (usd > 5) {
        issues.push({
          severity: 'medium',
          area: 'cost',
          title: `${prov} খরচ বেশি: $${usd.toFixed(2)} (২৪ঘণ্টা)`,
          detail: 'স্বাভাবিকের চেয়ে বেশি — কারণ চেক করুন।',
          signal: `AgentCostEvent provider=${prov}`,
        })
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const stale = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const stuck = await db.agentPendingAction.count({
      where: { status: 'pending', createdAt: { lt: stale } },
    })
    if (stuck > 0) {
      issues.push({
        severity: 'low',
        area: 'approvals',
        title: `${stuck}টি pending অ্যাকশন ২৪ঘণ্টার বেশি ঝুলে আছে`,
        detail: 'হয় approve/reject করুন অথবা কেন আটকে আছে দেখুন।',
        signal: 'AgentPendingAction status=pending',
      })
    }
  } catch {
    /* ignore */
  }

  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])

  const highCount = issues.filter(i => i.severity === 'high').length
  const summary = issues.length === 0
    ? '✅ আজ কোনো সমস্যা ধরা পড়েনি — সিস্টেম সুস্থ।'
    : `⚠️ ${issues.length}টি বিষয় নজরে এসেছে (${highCount}টি জরুরি)।`

  return { scannedAt: new Date().toISOString(), ok: issues.length === 0, issues, summary }
}
