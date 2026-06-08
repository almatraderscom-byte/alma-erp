import { prisma } from '@/lib/prisma'
import { AGENT_ACTOR } from '@/lib/agent-api/constants'
import type { Prisma } from '@prisma/client'

export interface AuditWriteInput {
  actionType: string
  resourceId?: string | null
  payload?: Record<string, unknown> | null
  ipAddress?: string | null
  actor?: string
}

/** Insert audit row — call from every agent write endpoint. */
export async function logAgentAudit(input: AuditWriteInput): Promise<string> {
  const row = await prisma.agentAuditLog.create({
    data: {
      actionType: input.actionType,
      resourceId: input.resourceId ?? null,
      payload: (input.payload ?? undefined) as Prisma.InputJsonValue | undefined,
      actor: input.actor ?? AGENT_ACTOR,
      ipAddress: input.ipAddress ?? null,
    },
    select: { id: true },
  })
  return row.id
}

export async function listRecentAudits(limit = 50, actionType?: string) {
  const rows = await prisma.agentAuditLog.findMany({
    where: actionType ? { actionType } : undefined,
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
  })
  return rows.map(r => ({
    id: r.id,
    actionType: r.actionType,
    resourceId: r.resourceId,
    payload: r.payload,
    actor: r.actor,
    ipAddress: r.ipAddress,
    createdAt: r.createdAt.toISOString(),
  }))
}
