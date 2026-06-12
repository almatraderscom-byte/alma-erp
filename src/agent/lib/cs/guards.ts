import { createHash } from 'crypto'
import { prisma } from '@/lib/prisma'
import { notifyOwner } from '@/agent/lib/notify-owner'
import { recordCsEvent } from '@/agent/lib/cs/analytics'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const MAX_REPLIES_PER_DAY = 30
const LOOP_THRESHOLD = 4

function dhakaDateStr(d = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

export async function isCsBlocked(pageId: string, psid: string): Promise<boolean> {
  const row = await db.csBlock.findUnique({
    where: { pageId_psid: { pageId, psid } },
  })
  return !!row
}

export async function blockCsCustomer(input: {
  pageId: string
  psid: string
  reason?: string
  blockedBy?: string
}): Promise<void> {
  await db.csBlock.upsert({
    where: { pageId_psid: { pageId: input.pageId, psid: input.psid } },
    create: {
      pageId: input.pageId,
      psid: input.psid,
      reason: input.reason ?? null,
      blockedBy: input.blockedBy ?? null,
    },
    update: { reason: input.reason ?? null, blockedBy: input.blockedBy ?? null },
  })
  await db.csConversation.updateMany({
    where: { pageId: input.pageId, psid: input.psid },
    data: { mode: 'human', status: 'human' },
  })
}

export type GuardResult =
  | { allowed: true }
  | { allowed: false; reason: 'blocked' | 'rate_limited' | 'spam_silent'; message?: string }

export async function checkCsGuards(input: {
  conversationId: string
  pageId: string
  psid: string
  userText: string
}): Promise<GuardResult> {
  if (await isCsBlocked(input.pageId, input.psid)) {
    return { allowed: false, reason: 'blocked' }
  }

  const conv = await db.csConversation.findUnique({ where: { id: input.conversationId } })
  if (!conv) return { allowed: true }

  const today = dhakaDateStr()
  let repliesToday = conv.agentRepliesToday ?? 0
  if (conv.agentRepliesResetDate !== today) repliesToday = 0

  if (repliesToday >= MAX_REPLIES_PER_DAY) {
    await recordCsEvent('rate_limited', { conversationId: input.conversationId, metadata: { psid: input.psid } })
    await notifyOwner({
      tier: 1,
      title: '⚠️ CS Rate Limit',
      message: `কাস্টমার ${input.psid} আজ ${MAX_REPLIES_PER_DAY}+ রিপ্লাই — পজ করা হয়েছে।`,
      category: 'urgent',
    })
    return {
      allowed: false,
      reason: 'rate_limited',
      message: 'ভাইয়া, আজ অনেক মেসেজ হয়ে গেছে। কাল আবার লিখুন বা ইনবক্সে কল করুন 🙏',
    }
  }

  const spam = detectSpam(input.userText)
  if (spam === 'abusive') {
    if (!conv.abuseWarned) {
      await db.csConversation.update({
        where: { id: input.conversationId },
        data: { abuseWarned: true },
      })
      return {
        allowed: false,
        reason: 'spam_silent',
        message: 'ভাইয়া, শালীনভাবে কথা বললে সাহায্য করতে পারব 🙏',
      }
    }
    await notifyOwner({
      tier: 1,
      title: '⚠️ CS Abuse',
      message: `অশালীন মেসেজ — ${input.psid}\n"${input.userText.slice(0, 120)}"`,
      category: 'urgent',
    })
    return { allowed: false, reason: 'spam_silent' }
  }

  const hash = questionHash(input.userText)
  if (hash && hash === conv.lastQuestionHash) {
    const loopCount = (conv.loopCount ?? 0) + 1
    await db.csConversation.update({
      where: { id: input.conversationId },
      data: { loopCount, lastQuestionHash: hash },
    })
    if (loopCount >= LOOP_THRESHOLD) {
      await db.csConversation.update({
        where: { id: input.conversationId },
        data: { mode: 'human', status: 'human' },
      })
      await notifyOwner({
        tier: 1,
        title: '🙋 CS Loop Handoff',
        message: `একই প্রশ্ন ${loopCount} বার — ${input.psid}\nConv: ${input.conversationId}`,
        category: 'urgent',
      })
      return { allowed: false, reason: 'spam_silent' }
    }
  } else if (hash) {
    await db.csConversation.update({
      where: { id: input.conversationId },
      data: { lastQuestionHash: hash, loopCount: 1 },
    })
  }

  return { allowed: true }
}

export async function incrementCsReplyCount(conversationId: string): Promise<void> {
  const today = dhakaDateStr()
  const conv = await db.csConversation.findUnique({ where: { id: conversationId } })
  if (!conv) return

  const reset = conv.agentRepliesResetDate !== today
  await db.csConversation.update({
    where: { id: conversationId },
    data: {
      agentRepliesResetDate: today,
      agentRepliesToday: reset ? 1 : { increment: 1 },
      lastCsReplyAt: new Date(),
    },
  })
  await recordCsEvent('agent_reply', { conversationId })
}

function questionHash(text: string): string | null {
  const norm = text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200)
  if (norm.length < 8) return null
  return createHash('sha256').update(norm).digest('hex').slice(0, 16)
}

function detectSpam(text: string): 'ok' | 'abusive' {
  const t = text.toLowerCase()
  const abusive = [
    /fuck|shit|bitch|bastard/i,
    /মাগী|বেশ্যা|হারামি|কুত্তা/i,
  ]
  if (abusive.some((r) => r.test(t))) return 'abusive'
  if ((t.match(/http/gi) ?? []).length > 3) return 'abusive'
  return 'ok'
}
