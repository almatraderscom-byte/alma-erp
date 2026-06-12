import { prisma } from '@/lib/prisma'
import { recordCsEvent } from '@/agent/lib/cs/analytics'
import { sendMessengerText } from '@/agent/lib/cs/meta-messenger'
import { incrementCsReplyCount } from '@/agent/lib/cs/guards'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const WINDOW_MS = 23 * 60 * 60 * 1000

export type FollowupType = 'price_no_reply' | 'half_order' | 'post_confirm_thanks'

export async function isFollowupsEnabled(): Promise<boolean> {
  const row = await db.agentKvSetting.findUnique({ where: { key: 'cs_followups_enabled' } })
  return String(row?.value ?? 'true') !== 'false'
}

export async function setFollowupsEnabled(on: boolean): Promise<void> {
  await db.agentKvSetting.upsert({
    where: { key: 'cs_followups_enabled' },
    update: { value: on ? 'true' : 'false' },
    create: { key: 'cs_followups_enabled', value: on ? 'true' : 'false' },
  })
}

/** Max one follow-up per conversation per calendar day (Dhaka). */
async function canScheduleToday(conversationId: string, type: FollowupType): Promise<boolean> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  const start = new Date(`${today}T00:00:00+06:00`)
  const existing = await db.csFollowup.count({
    where: {
      conversationId,
      type,
      createdAt: { gte: start },
      status: { in: ['pending', 'sent'] },
    },
  })
  return existing === 0
}

export async function scheduleFollowup(input: {
  conversationId: string
  type: FollowupType
  delayMs: number
  messageText: string
  metadata?: Record<string, unknown>
}): Promise<string | null> {
  if (!(await isFollowupsEnabled())) return null
  if (!(await canScheduleToday(input.conversationId, input.type))) return null

  const scheduledAt = new Date(Date.now() + input.delayMs)
  const row = await db.csFollowup.create({
    data: {
      conversationId: input.conversationId,
      type: input.type,
      scheduledAt,
      messageText: input.messageText,
      metadata: input.metadata ?? {},
      status: 'pending',
    },
  })
  return row.id
}

export async function schedulePriceNoReplyFollowup(
  conversationId: string,
  productLabel: string,
  stockLow: boolean,
): Promise<void> {
  const delayMs = (3 + Math.random() * 3) * 60 * 60 * 1000
  const stockLine = stockLow ? ' stock কিন্তু কমে আসছে 🙂' : ''
  await scheduleFollowup({
    conversationId,
    type: 'price_no_reply',
    delayMs,
    messageText: `ভাইয়া, ওই ${productLabel} নিয়ে আর কিছু জানতে চান?${stockLine}`,
    metadata: { productLabel, stockLow },
  })
}

export async function scheduleHalfOrderFollowup(conversationId: string): Promise<void> {
  await scheduleFollowup({
    conversationId,
    type: 'half_order',
    delayMs: 2 * 60 * 60 * 1000,
    messageText: 'ভাইয়া, অর্ডারটা শেষ করতে চান? নাম, ফোন, ঠিকানা দিলেই প্রসেস শুরু করতে পারি 😊',
  })
}

export async function schedulePostConfirmThanks(conversationId: string): Promise<void> {
  await scheduleFollowup({
    conversationId,
    type: 'post_confirm_thanks',
    delayMs: 30 * 60 * 1000,
    messageText: 'আলহামদুলিল্লাহ অর্ডার কনফার্ম হয়েছে ভাইয়া 🙏 পেজ ফলো রাখলে নতুন কালেকশন মিস করবেন না।',
  })
}

/**
 * HARD RULE: follow-up sends only if now − lastCustomerMessageAt < 23 hours.
 */
export async function processDueFollowups(): Promise<{ sent: number; expired: number }> {
  if (!(await isFollowupsEnabled())) return { sent: 0, expired: 0 }

  const now = new Date()
  const due = await db.csFollowup.findMany({
    where: { status: 'pending', scheduledAt: { lte: now } },
    include: { conversation: true },
    take: 50,
  })

  let sent = 0
  let expired = 0

  for (const fu of due) {
    const conv = fu.conversation
    if (!conv || conv.mode === 'human' || conv.status === 'human') {
      await db.csFollowup.update({ where: { id: fu.id }, data: { status: 'cancelled' } })
      continue
    }

    const lastCust = conv.lastCustomerMessageAt ?? conv.lastMessageAt
    const ageMs = now.getTime() - new Date(lastCust).getTime()

    if (ageMs >= WINDOW_MS) {
      await db.csFollowup.update({
        where: { id: fu.id },
        data: { status: 'expired' },
      })
      await recordCsEvent('followup_expired', {
        conversationId: conv.id,
        metadata: { followupId: fu.id, type: fu.type, ageHours: Math.round(ageMs / 3600000) },
      })
      expired++
      continue
    }

    const text = fu.messageText ?? ''
    if (!text) {
      await db.csFollowup.update({ where: { id: fu.id }, data: { status: 'cancelled' } })
      continue
    }

    try {
      await sendMessengerText(conv.pageId, conv.psid, text)
      await db.csFollowup.update({
        where: { id: fu.id },
        data: { status: 'sent', sentAt: now },
      })
      await incrementCsReplyCount(conv.id)
      await recordCsEvent('followup_sent', {
        conversationId: conv.id,
        metadata: { followupId: fu.id, type: fu.type },
      })
      sent++
    } catch (err) {
      await db.csFollowup.update({
        where: { id: fu.id },
        data: { status: 'failed', metadata: { ...fu.metadata as object, error: String(err) } },
      })
    }
  }

  return { sent, expired }
}
