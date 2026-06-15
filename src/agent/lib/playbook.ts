import { prisma } from '@/lib/prisma'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'

export const PLAYBOOK_DOMAINS = ['content', 'ads', 'staff', 'pricing', 'customer', 'ops'] as const
export type PlaybookDomain = typeof PLAYBOOK_DOMAINS[number]

export type ActivePlaybookEntry = {
  id: string
  domain: string
  heuristic: string
  confidence: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function getActivePlaybook(businessId: AgentBusinessId): Promise<ActivePlaybookEntry[]> {
  try {
    const rows = await db.agentPlaybook.findMany({
      where: { businessId, status: 'active' },
      orderBy: { confidence: 'desc' },
      take: 12,
      select: { id: true, domain: true, heuristic: true, confidence: true },
    })
    return rows as ActivePlaybookEntry[]
  } catch {
    return []
  }
}

export function inferPlaybookDomain(toolName: string): PlaybookDomain | null {
  const n = toolName.toLowerCase()
  if (/content|facebook|post|image|brand|tryon|catalog|gate1/.test(n)) return 'content'
  if (/ads|campaign|meta_ad|oxylabs/.test(n)) return 'ads'
  if (/staff|dispatch|morale|lunch|leave|task/.test(n)) return 'staff'
  if (/customer|cs|messenger|winback|segment/.test(n)) return 'customer'
  if (/price|pricing|catalog|product|order/.test(n)) return 'pricing'
  if (/erp|diagnostic|website|research|seo|competitor/.test(n)) return 'ops'
  return null
}

export async function bumpPlaybookForTool(toolName: string, businessId: AgentBusinessId): Promise<void> {
  const domain = inferPlaybookDomain(toolName)
  if (!domain) return
  try {
    await db.agentPlaybook.updateMany({
      where: { businessId, status: 'active', domain },
      data: { timesApplied: { increment: 1 } },
    })
  } catch {
    /* best-effort */
  }
}
