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
  // Which drafts the imminent cutoff will actually take.
  //
  // The sweep locks `createdAt < todayStart` once the BD hour reaches the cutoff.
  // An hour before a cutoff of 6, that is still today, so "before today" is the
  // right population. But a cutoff of MIDNIGHT fires an hour after 23:00, by
  // which time "today" has rolled over — the rows it takes are everything
  // pending now, today's included. Filtering on `< todayStart` there would warn
  // about nothing while the evening warning it displaced stayed suppressed.
  const { start: todayStart, end: tomorrowStart } = tradingBdDayBounds()
  const lockBoundary = telegramDraftLockHourBd() === 0 ? tomorrowStart : todayStart

  const where = {
    businessId: TRADING_BUSINESS_ID,
    status: 'PENDING' as const,
    ...(urgency === 'FINAL' ? { createdAt: { lt: lockBoundary } } : {}),
  }

  // Page through EVERY pending draft. A flat `take` silently warned only the
  // staff who happened to own the oldest rows, and under-counted the groups it
  // did warn — and because the cooldown then skipped those same groups, the
  // omitted ones were never reached before the cutoff.
  const drafts: Array<{
    telegramUserId: string
    telegramChatId: string
    telegramUsername: string | null
    usdtAmount: unknown
    createdAt: Date
    user: { name: string } | null
  }> = []
  const pageSize = 500
  let cursor: string | undefined
  for (;;) {
    const page = await prisma.tradingTelegramDraft.findMany({
      where,
      select: {
        id: true,
        telegramUserId: true,
        telegramChatId: true,
        telegramUsername: true,
        usdtAmount: true,
        createdAt: true,
        user: { select: { name: true } },
      },
      orderBy: { id: 'asc' },
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    drafts.push(...page)
    if (page.length < pageSize) break
    cursor = page[page.length - 1].id
  }
  // Oldest-first so the first row seen in a group really is its oldest.
  drafts.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

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
    // A midnight cutoff is warned at 23:00, so "আজ ভোর 0টায়" would name a time
    // that passed 23 hours ago. Say what the deadline actually is.
    const deadline = lockHour === 0
      ? 'আজ রাত ১২টায় (আর ১ ঘণ্টা)'
      : `আজ ভোর ${lockHour}টায়`
    return [
      `⏰ ${who} — ${group.count}টি ট্রেড এখনো কনফার্ম হয়নি${volume}।`,
      `সবচেয়ে পুরোনোটি ${group.oldestYmd} তারিখের।`,
      `${deadline} এগুলো লক হয়ে যাবে — তখন অ্যাডমিন ছাড়া খোলা যাবে না।`,
      `অ্যাপের Telegram সেকশন থেকে এখনই কনফার্ম করুন।`,
    ].join('\n')
  }

  return [
    `📋 ${who} — আজ ${group.count}টি ট্রেড কনফার্মের অপেক্ষায়${volume}।`,
    `কনফার্ম না করলে ব্যালান্স আর প্রফিটে বসবে না।`,
    lockHour === 0
      ? `আজ রাত ১২টার পর এগুলো লক হয়ে যায়, তাই ঘুমানোর আগে অ্যাপ থেকে সেরে ফেলুন।`
      : `ভোর ${lockHour}টার পর এগুলো লক হয়ে যায়, তাই ঘুমানোর আগে অ্যাপ থেকে সেরে ফেলুন।`,
  ].join('\n')
}

/**
 * Warned recently? Retries and overlapping runs must not spam the group.
 *
 * Keyed by staffer, chat AND urgency. Chat because the groups are per chat and a
 * user-only key would let the first send silence the second chat's queue.
 * Urgency because with the cutoff hour set between 1 and 4 the FINAL warning
 * falls inside the evening warning's cooldown — the one message that matters
 * most would be the one suppressed.
 */
async function nudgedRecently(
  telegramUserId: string,
  telegramChatId: string,
  urgency: ConfirmNudgeUrgency,
): Promise<boolean> {
  const since = new Date(Date.now() - NUDGE_COOLDOWN_MS)
  const recent = await prisma.tradingTelegramAuditLog.findFirst({
    where: {
      businessId: TRADING_BUSINESS_ID,
      eventType: NUDGE_EVENT,
      telegramUserId,
      telegramChatId,
      // Audit detail is written as `${urgency}; …` — see sendPendingConfirmNudges.
      detail: { startsWith: urgency },
      createdAt: { gte: since },
    },
    select: { id: true },
  })
  return Boolean(recent)
}

/**
 * Deterministic primary key for one warning: one per staffer, per chat, per
 * urgency, per BD DAY.
 *
 * Per-day rather than per-hour on purpose. The final warning fires across a
 * short window (see confirmNudgeUrgencyForNow), so an hour-keyed reservation
 * would let the same warning go out twice. Per-day, the first success owns the
 * day and later hours skip — while a FAILED send deletes its reservation, so the
 * next hour inside the window retries instead of losing the warning entirely.
 */
function reservationId(urgency: ConfirmNudgeUrgency, group: PendingGroup): string {
  const dayStamp = tradingBdNow().toISOString().slice(0, 10)   // YYYY-MM-DD, Dhaka
  return `nudge:${urgency}:${group.telegramChatId}:${group.telegramUserId}:${dayStamp}`
}

export async function sendPendingConfirmNudges(urgency: ConfirmNudgeUrgency) {
  const groups = await collectPendingConfirmGroups(urgency)
  const sent: string[] = []
  const skipped: string[] = []

  for (const group of groups) {
    if (await nudgedRecently(group.telegramUserId, group.telegramChatId, urgency)) {
      skipped.push(group.telegramUserId)
      continue
    }

    // Reserve BEFORE calling Telegram, and reserve EXCLUSIVELY. A plain insert is
    // not a reservation: two overlapping runs both succeed and staff get the
    // reminder twice. Composing the PRIMARY KEY from (urgency, chat, staffer,
    // hour) makes the second insert fail on the key itself — atomic, and no new
    // table or unique index. A run that loses the race does not send.
    const claimId = reservationId(urgency, group)
    const reserved = await prisma.tradingTelegramAuditLog.create({
      data: {
        id: claimId,
        businessId: TRADING_BUSINESS_ID,
        eventType: NUDGE_EVENT,
        telegramUserId: group.telegramUserId,
        telegramUsername: group.telegramUsername,
        telegramChatId: group.telegramChatId,
        detail: `${urgency}; ${group.count} pending; oldest ${group.oldestYmd}`,
      },
      select: { id: true },
    }).catch(() => null)
    if (!reserved) {
      skipped.push(group.telegramUserId)
      continue
    }

    const result = await sendTelegramMessage(group.telegramChatId, confirmNudgeText(group, urgency))
    if (!result.ok) {
      skipped.push(group.telegramUserId)
      // Release so the next hour retries rather than inheriting a phantom warning.
      await prisma.tradingTelegramAuditLog.delete({ where: { id: claimId } }).catch(() => {})
      continue
    }

    sent.push(group.telegramUserId)
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
/** How many hours before the cutoff the final warning may be attempted. */
const FINAL_WINDOW_HOURS = 2

export function confirmNudgeUrgencyForNow(now = tradingBdNow()): ConfirmNudgeUrgency | null {
  const hour = now.getUTCHours()          // tradingBdNow is UTC-shifted: this IS the Dhaka hour
  const lockHour = telegramDraftLockHourBd()
  // Wrap, don't clamp: a cutoff of 0 means the last chance is 23:00 the evening
  // before. Clamping to 0 would have fired the "one hour left" warning when the
  // cutoff was already active and the sweep may already have locked the rows.
  //
  // A WINDOW, not a single hour: one transient Telegram failure at the only
  // eligible hour would otherwise lose that day's warning outright, because the
  // next hourly run returns null and never looks again. The day-keyed
  // reservation stops the window from sending twice.
  for (let back = 1; back <= FINAL_WINDOW_HOURS; back += 1) {
    if (hour === (lockHour + 24 - back) % 24) return 'FINAL'
  }
  // When the two collide (cutoff 0 or 1), the urgent one has already won above.
  if (hour === 23) return 'EVENING'
  return null
}
