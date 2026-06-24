/**
 * Office group chat — a Messenger-style room shared by the owner, all staff,
 * and the agent. Messages are business-scoped.
 *
 * Agent replies are a one-shot, owner-approved flow (owner decision):
 *   1. A staff posts → the agent drafts ONE reply (DeepSeek, see office-chat-agent.ts)
 *      stored with status='pending' and isAgentReply=true.
 *   2. The pending draft is visible to the OWNER only. The owner approves it
 *      (status='posted' → shown to everyone) or dismisses it (status='dismissed').
 *   3. Staff never see 'pending'/'dismissed' rows — their feed is 'posted' only.
 *
 * This module reads/writes rows + manages the draft lifecycle; the model call
 * itself lives in office-chat-agent.ts.
 */
import { prisma } from '@/lib/prisma'

export type ChatAuthor = 'owner' | 'staff' | 'agent'

/** 'posted' = live for everyone · 'pending' = agent draft awaiting owner · 'dismissed' = rejected. */
export type ChatStatus = 'posted' | 'pending' | 'dismissed'

export type ChatMessage = {
  id: string
  authorType: string
  authorStaffId: string | null
  authorName: string
  body: string
  taskRef: string | null
  isAgentReply: boolean
  /** Draft lifecycle — 'pending' rows are agent replies the owner must approve. */
  status: ChatStatus
  /** Group message this is a reply to (set on agent drafts). */
  replyToId: string | null
  createdAt: string
}

export type ChatFeed = {
  businessId: string
  messages: ChatMessage[]
}

export async function getGroupMessages(
  businessId = 'ALMA_LIFESTYLE',
  opts: { includePending?: boolean; limit?: number } = {},
): Promise<ChatFeed> {
  const limit = opts.limit ?? 60
  // Staff see only live messages. The owner additionally sees pending agent
  // drafts (to approve/dismiss). 'dismissed' rows are never returned.
  const statusFilter: ChatStatus[] = opts.includePending ? ['posted', 'pending'] : ['posted']
  const rows = await prisma.officeGroupMessage.findMany({
    where: { businessId, status: { in: statusFilter } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      authorType: true,
      authorStaffId: true,
      body: true,
      taskRef: true,
      isAgentReply: true,
      status: true,
      replyToId: true,
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
      status: (r.status as ChatStatus) ?? 'posted',
      replyToId: r.replyToId,
      createdAt: r.createdAt.toISOString(),
    }))

  return { businessId, messages }
}

const ROW_SELECT = {
  id: true,
  authorType: true,
  authorStaffId: true,
  body: true,
  taskRef: true,
  isAgentReply: true,
  status: true,
  replyToId: true,
  createdAt: true,
} as const

function toChatMessage(row: {
  id: string
  authorType: string
  authorStaffId: string | null
  body: string
  taskRef: string | null
  isAgentReply: boolean
  status: string
  replyToId: string | null
  createdAt: Date
}): ChatMessage {
  return {
    id: row.id,
    authorType: row.authorType,
    authorStaffId: row.authorStaffId,
    authorName: row.authorType === 'owner' ? 'মালিক' : row.authorType === 'agent' ? 'এজেন্ট' : 'স্টাফ',
    body: row.body,
    taskRef: row.taskRef,
    isAgentReply: row.isAgentReply,
    status: (row.status as ChatStatus) ?? 'posted',
    replyToId: row.replyToId,
    createdAt: row.createdAt.toISOString(),
  }
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
      status: 'posted',
      businessId: args.businessId,
    },
    select: ROW_SELECT,
  })
  return toChatMessage(row)
}

/**
 * Has the agent already taken its one shot at replying to this message? Enforces
 * the owner's "agent replies once" rule — counts ANY prior draft (pending,
 * posted, or even dismissed), so a dismissed draft is never silently re-drafted.
 */
export async function hasAgentReplyFor(replyToId: string, businessId: string): Promise<boolean> {
  const existing = await prisma.officeGroupMessage.findFirst({
    where: { businessId, replyToId, authorType: 'agent' },
    select: { id: true },
  })
  return Boolean(existing)
}

/** Store the agent's one-shot reply as a PENDING draft (owner-only until approved). */
export async function createAgentDraft(args: {
  businessId: string
  replyToId: string
  body: string
  taskRef?: string | null
}): Promise<ChatMessage> {
  const row = await prisma.officeGroupMessage.create({
    data: {
      authorType: 'agent',
      body: args.body.trim(),
      replyToId: args.replyToId,
      taskRef: args.taskRef ?? null,
      isAgentReply: true,
      status: 'pending',
      businessId: args.businessId,
    },
    select: ROW_SELECT,
  })
  return toChatMessage(row)
}

/**
 * Owner approves (→ 'posted') or dismisses (→ 'dismissed') a pending agent
 * draft. Optionally replaces the body if the owner edited it before approving.
 * Returns null if the row isn't a pending agent draft in this business.
 */
export async function resolveAgentDraft(args: {
  id: string
  businessId: string
  action: 'approve' | 'dismiss'
  editedBody?: string | null
}): Promise<ChatMessage | null> {
  const draft = await prisma.officeGroupMessage.findFirst({
    where: { id: args.id, businessId: args.businessId, authorType: 'agent', status: 'pending' },
    select: { id: true },
  })
  if (!draft) return null

  const data: { status: ChatStatus; body?: string } = {
    status: args.action === 'approve' ? 'posted' : 'dismissed',
  }
  if (args.action === 'approve' && args.editedBody && args.editedBody.trim()) {
    data.body = args.editedBody.trim()
  }
  const row = await prisma.officeGroupMessage.update({
    where: { id: args.id },
    data,
    select: ROW_SELECT,
  })
  return toChatMessage(row)
}
