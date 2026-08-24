import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID } from '@/lib/trading'
import {
  telegramDraftLockHourBd,
  tradingBdDayBounds,
  tradingBdNow,
  tradingBdYmdFromInstant,
} from '@/lib/trading-compliance'
import { sendTelegramMessage } from '@/lib/trading-telegram-bot'

/**
 * Remind staff about drafts that are about to auto-lock.
 *
 * Owner decision 2026-08-24: keep the day-cutoff lock — it is the control that
 * stops yesterday's trades being entered late without oversight — but stop it
 * ambushing people. Staff let drafts pile up and confirm a batch when they are
 * free, so the lock hits drafts nobody was ignoring on purpose. A warning the
 * evening before, and one an hour ahead, means it almost never bites; and when
 * it does, they were told.
 */

const NUDGE_EVENT = 'CONFIRM_NUDGE'
/** Don't re-warn the same person inside this window (retries, overlapping runs). */
const NUDGE_COOLDOWN_MS = 4 * 60 * 60_000

export type ConfirmNudgeUrgency = 'EVENING' | 'FINAL'

type PendingGroup = {
  telegramUserId: string
  telegramChatId: string
  staffName: string
  telegramUsername: string | null
  count: number
  oldestYmd: string
  totalUsdt: number
}

/**
 * PENDING drafts grouped per staffer per chat.
 *
 * `FINAL` only cares about drafts already past the day boundary — those are the
 * ones the sweep locks at the cutoff hour. `EVENING` warns about everything still
 * open, because today's rows cross that boundary at midnight.
 */
export async function collectPendingConfirmGroups(urgency: ConfirmNudgeUrgency): Promise<PendingGroup[]> {
  const { start: todayStart } = tradingBdDayBounds()

  const drafts = await prisma.tradingTelegramDraft.findMany({
    where: {
      businessId: TRADING_BUSINESS_ID,
      status: 'PENDING',
      ...(urgency === 'FINAL' ? { createdAt: { lt: todayStart } } : {}),
    },
    select: {
      telegramUserId: true,
      telegramChatId: true,
      telegramUsername: true,
      usdtAmount: true,
      createdAt: true,
      user: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
  })

  const groups = new Map<string, PendingGroup>()
  for (const draft of drafts) {
    const key = `${draft.telegramUserId}:${draft.telegramChatId}`
    const existing = groups.get(key)
    if (existing) {
      existing.count += 1
      existing.totalUsdt += Number(draft.usdtAmount ?? 0)
      continue
    }
    groups.set(key, {
      telegramUserId: draft.telegramUserId,
      telegramChatId: draft.telegramChatId,
      telegramUsername: draft.telegramUsername,
      staffName: draft.user?.name || draft.telegramUsername || draft.telegramUserId,
      count: 1,
      totalUsdt: Number(draft.usdtAmount ?? 0),
      // Drafts arrive oldest-first, so the first one seen is the oldest.
      oldestYmd: tradingBdYmdFromInstant(draft.createdAt),
    })
  }

  return [...groups.values()]
}

export function confirmNudgeText(group: PendingGroup, urgency: ConfirmNudgeUrgency): string {
  const who = group.telegramUsername ? `@${group.telegramUsername}` : group.staffName
  const lockHour = telegramDraftLockHourBd()
  const volume = group.totalUsdt > 0 ? ` (মোট ${group.totalUsdt.toFixed(2)} USDT)` : ''

  if (urgency === 'FINAL') {
    return [
      `⏰ ${who} — ${group.count}টি ট্রেড এখনো কনফার্ম হয়নি${volume}।`,
      `সবচেয়ে পুরোনোটি ${group.oldestYmd} তারিখের।`,
      `আজ ভোর ${lockHour}টায় এগুলো লক হয়ে যাবে — তখন অ্যাডমিন ছাড়া খোলা যাবে না।`,
      `অ্যাপের Telegram সেকশন থেকে এখনই কনফার্ম করুন।`,
    ].join('\n')
  }

  return [
    `📋 ${who} — আজ ${group.count}টি ট্রেড কনফার্মের অপেক্ষায়${volume}।`,
    `কনফার্ম না করলে ব্যালান্স আর প্রফিটে বসবে না।`,
    `ভোর ${lockHour}টার পর এগুলো লক হয়ে যায়, তাই ঘুমানোর আগে অ্যাপ থেকে সেরে ফেলুন।`,
  ].join('\n')
}

/**
 * Warned recently? Retries and overlapping runs must not spam the group.
 *
 * Keyed by staffer AND chat, because the groups are: one staffer with drafts in
 * two approved chats gets one message per chat, and a user-only key would let
 * the first send silence the second chat's queue.
 */
async function nudgedRecently(telegramUserId: string, telegramChatId: string): Promise<boolean> {
  const since = new Date(Date.now() - NUDGE_COOLDOWN_MS)
  const recent = await prisma.tradingTelegramAuditLog.findFirst({
    where: {
      businessId: TRADING_BUSINESS_ID,
      eventType: NUDGE_EVENT,
      telegramUserId,
      telegramChatId,
      createdAt: { gte: since },
    },
    select: { id: true },
  })
  return Boolean(recent)
}

export async function sendPendingConfirmNudges(urgency: ConfirmNudgeUrgency) {
  const groups = await collectPendingConfirmGroups(urgency)
  const sent: string[] = []
  const skipped: string[] = []

  for (const group of groups) {
    if (await nudgedRecently(group.telegramUserId, group.telegramChatId)) {
      skipped.push(group.telegramUserId)
      continue
    }

    const result = await sendTelegramMessage(group.telegramChatId, confirmNudgeText(group, urgency))
    if (!result.ok) {
      skipped.push(group.telegramUserId)
      continue
    }

    sent.push(group.telegramUserId)
    await prisma.tradingTelegramAuditLog.create({
      data: {
        businessId: TRADING_BUSINESS_ID,
        eventType: NUDGE_EVENT,
        telegramUserId: group.telegramUserId,
        telegramUsername: group.telegramUsername,
        telegramChatId: group.telegramChatId,
        detail: `${urgency}; ${group.count} pending; oldest ${group.oldestYmd}`,
      },
    }).catch(() => {})
  }

  return { urgency, groups: groups.length, sent: sent.length, skipped: skipped.length }
}

/**
 * Which warning this run should send, from the BD clock.
 *
 * The cron fires HOURLY and this picks the window. Pinning two UTC schedules
 * instead would silently drop the final warning the moment
 * `TELEGRAM_DRAFT_LOCK_HOUR_BD` moves off its default — the schedule would still
 * say 05:00 while the cutoff had moved. Twenty-two of the twenty-four runs return
 * immediately without touching the database.
 */
export function confirmNudgeUrgencyForNow(now = tradingBdNow()): ConfirmNudgeUrgency | null {
  const hour = now.getUTCHours()          // tradingBdNow is UTC-shifted: this IS the Dhaka hour
  const lockHour = telegramDraftLockHourBd()
  if (hour === 23) return 'EVENING'
  if (hour === Math.max(0, lockHour - 1)) return 'FINAL'
  return null
}
