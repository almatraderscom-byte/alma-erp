/**
 * Office group chat — a Messenger-style room shared by the owner, all staff,
 * and the agent. Messages are business-scoped. The agent's replies are marked
 * isAgentReply (owner-approved one-shot explanations posted by the head); this
 * module only reads/writes rows — it does not invoke the model.
 */
import { prisma } from '@/lib/prisma'

export type ChatAuthor = 'owner' | 'staff' | 'agent'

export type ChatMessage = {
  id: string
  authorType: string
  authorStaffId: string | null
  authorName: string
  body: string
  taskRef: string | null
  isAgentReply: boolean
  createdAt: string
}

export type ChatFeed = {
  businessId: string
  messages: ChatMessage[]
}

export async function getGroupMessages(businessId = 'ALMA_LIFESTYLE', limit = 60): Promise<ChatFeed> {
  const rows = await prisma.officeGroupMessage.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      authorType: true,
      authorStaffId: true,
      body: true,
      taskRef: true,
      isAgentReply: true,
      createdAt: true,
    },
  })

  // Resolve staff names in one query.
  const staffIds = [...new Set(rows.map((r) => r.authorStaffId).filter((v): v is string => Boolean(v)))]
  const staffMap = new Map<string, string>()
  if (staffIds.length > 0) {
    const staff = await prisma.agentStaff.findMany({
      where: { id: { in: staffIds } },
      select: { id: true, name: true },
    })
    for (const s of staff) staffMap.set(s.id, s.name)
  }

  const messages: ChatMessage[] = rows
    .reverse() // oldest-first for display
    .map((r) => ({
      id: r.id,
      authorType: r.authorType,
      authorStaffId: r.authorStaffId,
      authorName:
        r.authorType === 'owner'
          ? 'মালিক'
          : r.authorType === 'agent'
            ? 'এজেন্ট'
            : (r.authorStaffId && staffMap.get(r.authorStaffId)) || 'স্টাফ',
      body: r.body,
      taskRef: r.taskRef,
      isAgentReply: r.isAgentReply,
      createdAt: r.createdAt.toISOString(),
    }))

  return { businessId, messages }
}

export async function postGroupMessage(args: {
  authorType: ChatAuthor
  authorStaffId?: string | null
  authorUserId?: string | null
  body: string
  taskRef?: string | null
  businessId: string
}): Promise<ChatMessage> {
  const body = args.body.trim()
  const row = await prisma.officeGroupMessage.create({
    data: {
      authorType: args.authorType,
      authorStaffId: args.authorStaffId ?? null,
      authorUserId: args.authorUserId ?? null,
      body,
      taskRef: args.taskRef ?? null,
      isAgentReply: args.authorType === 'agent',
      businessId: args.businessId,
    },
    select: {
      id: true,
      authorType: true,
      authorStaffId: true,
      body: true,
      taskRef: true,
      isAgentReply: true,
      createdAt: true,
    },
  })
  return {
    id: row.id,
    authorType: row.authorType,
    authorStaffId: row.authorStaffId,
    authorName: args.authorType === 'owner' ? 'মালিক' : args.authorType === 'agent' ? 'এজেন্ট' : 'স্টাফ',
    body: row.body,
    taskRef: row.taskRef,
    isAgentReply: row.isAgentReply,
    createdAt: row.createdAt.toISOString(),
  }
}
