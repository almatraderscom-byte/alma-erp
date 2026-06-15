/**
 * Visible learned-rules surface — active playbook + high-importance prefs.
 */
import { prisma } from '@/lib/prisma'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type LearnedRuleRow = {
  id: string
  kind: 'playbook' | 'memory'
  domain: string
  text: string
  timesApplied: number
  confidence: number
  status: string
  createdAt: string
}

export async function listLearnedRules(businessId: AgentBusinessId = 'ALMA_LIFESTYLE'): Promise<{
  rules: LearnedRuleRow[]
  grouped: Record<string, LearnedRuleRow[]>
}> {
  const [playbook, memories] = await Promise.all([
    db.agentPlaybook.findMany({
      where: { businessId, status: 'active' },
      orderBy: [{ timesApplied: 'desc' }, { confidence: 'desc' }],
      take: 40,
    }),
    db.agentMemory.findMany({
      where: {
        OR: [{ importance: { gte: 4 } }, { pinned: true }],
        scope: { not: 'personal' },
      },
      orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
      take: 20,
      select: { id: true, scope: true, content: true, importance: true, accessCount: true, createdAt: true, metadata: true },
    }),
  ])

  const rules: LearnedRuleRow[] = []

  for (const p of playbook as Array<{
    id: string; domain: string; heuristic: string; timesApplied: number; confidence: number; status: string; createdAt: Date
  }>) {
    rules.push({
      id: p.id,
      kind: 'playbook',
      domain: p.domain,
      text: p.heuristic,
      timesApplied: p.timesApplied ?? 0,
      confidence: p.confidence,
      status: p.status,
      createdAt: p.createdAt.toISOString(),
    })
  }

  for (const m of memories as Array<{
    id: string; scope: string; content: string; importance: number; accessCount: number; createdAt: Date; metadata: unknown
  }>) {
    const meta = m.metadata as Record<string, unknown> | null
    const tag = meta?.businessId as string | undefined
    if (tag && tag !== businessId) continue
    rules.push({
      id: m.id,
      kind: 'memory',
      domain: String(meta?.domain ?? m.scope),
      text: m.content,
      timesApplied: m.accessCount ?? 0,
      confidence: m.importance,
      status: 'active',
      createdAt: m.createdAt.toISOString(),
    })
  }

  const grouped: Record<string, LearnedRuleRow[]> = {}
  for (const r of rules) {
    grouped[r.domain] = grouped[r.domain] ?? []
    grouped[r.domain].push(r)
  }

  return { rules, grouped }
}

export async function forgetLearnedRule(
  id: string,
  kind: 'playbook' | 'memory',
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (kind === 'playbook') {
      await db.agentPlaybook.update({
        where: { id },
        data: { status: 'retired', reviewedAt: new Date() },
      })
      return { ok: true }
    }
    await db.agentMemory.delete({ where: { id } })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function bumpPlaybookRulesForDomains(
  domains: string[],
  businessId: AgentBusinessId = 'ALMA_LIFESTYLE',
): Promise<void> {
  if (!domains.length) return
  try {
    await db.agentPlaybook.updateMany({
      where: { businessId, status: 'active', domain: { in: domains } },
      data: { timesApplied: { increment: 1 } },
    })
  } catch { /* best-effort */ }
}
