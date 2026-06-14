import { prisma } from '@/lib/prisma'

export type AgentOutboxType =
  | 'task_dispatch'
  | 'reminder'
  | 'coaching'
  | 'presence'
  | 'announcement'
  | 'feedback_ack'

export async function queueAgentOutbox(args: {
  staffId?: string | null
  staffName?: string | null
  businessId?: string | null
  type: AgentOutboxType
  content: string
  relatedTaskIds?: string[] | null
}) {
  return prisma.agentOutbox.create({
    data: {
      staffId: args.staffId ?? null,
      staffName: args.staffName ?? null,
      businessId: args.businessId ?? null,
      type: args.type,
      content: args.content,
      status: 'queued',
      relatedTaskIds: args.relatedTaskIds ?? undefined,
    },
  })
}

export async function markAgentOutboxDelivered(
  id: string,
  telegramMessageId?: string | number | null,
) {
  return prisma.agentOutbox.update({
    where: { id },
    data: {
      status: 'delivered',
      telegramMessageId: telegramMessageId != null ? String(telegramMessageId) : null,
      sentAt: new Date(),
    },
  })
}

export async function markAgentOutboxFailed(id: string, errorReason: string) {
  return prisma.agentOutbox.update({
    where: { id },
    data: {
      status: 'failed',
      errorReason: errorReason.slice(0, 500),
      sentAt: new Date(),
    },
  })
}
