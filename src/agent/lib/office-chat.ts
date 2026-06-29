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
import { userAvatarUrl } from '@/lib/user-display'

export type ChatAuthor = 'owner' | 'staff' | 'agent'

/** 'posted' = live for everyone · 'pending' = agent draft awaiting owner · 'dismissed' = rejected. */
export type ChatStatus = 'posted' | 'pending' | 'dismissed'

/** An image (or other file) attached to a group message. */
export type ChatAttachment = { type: 'image'; url: string }

export type ChatMessage = {
  id: string
  authorType: string
  authorStaffId: string | null
  authorName: string
  /** Author's profile photo (staff/owner) for the chat avatar; null → initials. */
  authorImageUrl: string | null
  body: string
  /** Images attached to this message (empty when none). */
  attachments: ChatAttachment[]
  taskRef: string | null
  isAgentReply: boolean
  /** Draft lifecycle — 'pending' rows are agent replies the owner must approve. */
  status: ChatStatus
  /** Group message this is a reply to (set on agent drafts). */
  replyToId: string | null
  createdAt: string
}

/** Normalize the loose JSON `attachments` column into typed image attachments. */
function parseAttachments(v: unknown): ChatAttachment[] {
  if (!Array.isArray(v)) return []
  const out: ChatAttachment[] = []
  for (const a of v) {
    if (a && typeof a === 'object' && typeof (a as { url?: unknown }).url === 'string') {
      out.push({ type: 'image', url: (a as { url: string }).url })
    }
  }
  return out
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
      authorUserId: true,
      body: true,
      attachments: true,
      taskRef: true,
      isAgentReply: true,
      status: true,
      replyToId: true,
      createdAt: true,
    },
  })

  // Resolve staff names + profile photos in one query (staff → linked user photo).
  const staffIds = [...new Set(rows.map((r) => r.authorStaffId).filter((v): v is string => Boolean(v)))]
  const staffMap = new Map<string, { name: string; imageUrl: string | null }>()
  if (staffIds.length > 0) {
    const staff = await prisma.agentStaff.findMany({
      where: { id: { in: staffIds } },
      select: { id: true, name: true, user: { select: { id: true, profileImageUrl: true, updatedAt: true } } },
    })
    for (const s of staff) {
      const u = s.user
      staffMap.set(s.id, {
        name: s.name,
        imageUrl: u && u.profileImageUrl ? userAvatarUrl(u.id, u.updatedAt) : null,
      })
    }
  }

  // Owner photos (owner posts carry authorUserId).
  const ownerIds = [...new Set(rows.filter((r) => r.authorType === 'owner').map((r) => r.authorUserId).filter((v): v is string => Boolean(v)))]
  const ownerImg = new Map<string, string | null>()
  if (ownerIds.length > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: ownerIds } },
      select: { id: true, profileImageUrl: true, updatedAt: true },
    })
    for (const u of users) ownerImg.set(u.id, u.profileImageUrl ? userAvatarUrl(u.id, u.updatedAt) : null)
  }

  const messages: ChatMessage[] = rows
    .reverse() // oldest-first for display
    .map((r) => {
      const staff = r.authorStaffId ? staffMap.get(r.authorStaffId) : undefined
      return {
        id: r.id,
        authorType: r.authorType,
        authorStaffId: r.authorStaffId,
        authorName:
          r.authorType === 'owner'
            ? 'মালিক'
            : r.authorType === 'agent'
              ? 'এজেন্ট'
              : staff?.name || 'স্টাফ',
        authorImageUrl:
          r.authorType === 'owner'
            ? (r.authorUserId && ownerImg.get(r.authorUserId)) || null
            : r.authorType === 'agent'
              ? null
              : staff?.imageUrl ?? null,
        body: r.body,
        attachments: parseAttachments(r.attachments),
        taskRef: r.taskRef,
        isAgentReply: r.isAgentReply,
        status: (r.status as ChatStatus) ?? 'posted',
        replyToId: r.replyToId,
        createdAt: r.createdAt.toISOString(),
      }
    })

  return { businessId, messages }
}

const ROW_SELECT = {
  id: true,
  authorType: true,
  authorStaffId: true,
  body: true,
  attachments: true,
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
  attachments: unknown
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
    // Resolved by getGroupMessages on the next feed load; transient post-return is fine.
    authorImageUrl: null,
    body: row.body,
    attachments: parseAttachments(row.attachments),
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
  attachments?: ChatAttachment[]
  taskRef?: string | null
  businessId: string
}): Promise<ChatMessage> {
  const body = args.body.trim()
  const attachments = (args.attachments ?? []).filter((a) => a && typeof a.url === 'string' && a.url.length > 0)
  const row = await prisma.officeGroupMessage.create({
    data: {
      authorType: args.authorType,
      authorStaffId: args.authorStaffId ?? null,
      authorUserId: args.authorUserId ?? null,
      body,
      attachments: attachments.length > 0 ? attachments : undefined,
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
 * Post an agent task-explanation straight to the group (status='posted', no owner
 * approval). Unlike `createAgentDraft`, this is the owner-blessed auto-explain
 * path for the "আজকের কাজ" button: the staff asked the agent to clarify a task
 * they were already assigned, so the reply needs no gate. Carries the task ref +
 * the staff question it answers (replyToId) for threading.
 */
export async function postAgentTaskExplanation(args: {
  businessId: string
  body: string
  replyToId?: string | null
  taskRef?: string | null
}): Promise<ChatMessage> {
  const row = await prisma.officeGroupMessage.create({
    data: {
      authorType: 'agent',
      body: args.body.trim(),
      replyToId: args.replyToId ?? null,
      taskRef: args.taskRef ?? null,
      isAgentReply: true,
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
