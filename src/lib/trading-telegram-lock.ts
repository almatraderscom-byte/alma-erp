import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID } from '@/lib/trading'
import { telegramDraftLockHourBd, tradingBdDayBounds, tradingBdNow } from '@/lib/trading-compliance'
import { logTelegramDraftAudit } from '@/lib/trading-telegram-draft-audit'

/**
 * A confirm that dies between "mark APPROVED" and "trade written" used to strand
 * the draft: APPROVED with no tradingTradeId is invisible in the PENDING list,
 * absent from the account, and the review UI offers no button for it. The confirm
 * path rolls itself back now, but a serverless timeout or a crash can still land
 * a draft in that gap — so every list read sweeps it back to PENDING first.
 *
 * The grace window keeps a confirm that is still running (trade insert +
 * account recalc + snapshot refresh) from being swept out from under itself.
 */
const STUCK_APPROVED_GRACE_MS = 2 * 60_000

/** Return APPROVED-but-never-posted drafts to PENDING so staff can retry. Idempotent. */
export async function healStuckApprovedTelegramDrafts(): Promise<number> {
  const staleBefore = new Date(Date.now() - STUCK_APPROVED_GRACE_MS)

  const stuck = await prisma.tradingTelegramDraft.findMany({
    where: {
      businessId: TRADING_BUSINESS_ID,
      status: 'APPROVED',
      tradingTradeId: null,
      OR: [{ reviewedAt: { lt: staleBefore } }, { reviewedAt: null }],
    },
    select: { id: true, telegramUserId: true, telegramChatId: true, reviewedBy: true, confirmError: true },
    take: 100,
  })
  if (!stuck.length) return 0

  const result = await prisma.tradingTelegramDraft.updateMany({
    where: { id: { in: stuck.map(d => d.id) }, status: 'APPROVED', tradingTradeId: null },
    data: {
      status: 'PENDING',
      confirmError: 'Confirm did not finish — the trade was never written. Try Confirm again.',
      confirmErrorAt: new Date(),
    },
  })

  for (const draft of stuck) {
    // Best-effort trail: recovering the draft matters more than logging it.
    await logTelegramDraftAudit({
      eventType: 'DRAFT_CONFIRM_RECOVERED',
      draftId: draft.id,
      actorUserId: draft.reviewedBy ?? 'system',
      telegramUserId: draft.telegramUserId,
      telegramChatId: draft.telegramChatId,
      detail: 'APPROVED with no ledger trade — returned to PENDING',
    }).catch(() => {})
  }

  return result.count
}

/** Lock PENDING drafts from before today's BD day once past cutoff hour. Idempotent. */
export async function lockStalePendingTelegramDrafts(): Promise<number> {
  const now = tradingBdNow()
  if (now.getUTCHours() < telegramDraftLockHourBd()) return 0

  const { start: todayStart } = tradingBdDayBounds(now)
  const reason = `Auto-locked after BD ${telegramDraftLockHourBd()}:00 cutoff`

  const result = await prisma.tradingTelegramDraft.updateMany({
    where: {
      businessId: TRADING_BUSINESS_ID,
      status: 'PENDING',
      createdAt: { lt: todayStart },
    },
    data: {
      status: 'LOCKED',
      lockedAt: new Date(),
      lockedReason: reason,
    },
  })

  return result.count
}

export async function reopenLockedTelegramDraft(draftId: string, reviewerUserId: string) {
  const draft = await prisma.tradingTelegramDraft.findFirst({
    where: { id: draftId, businessId: TRADING_BUSINESS_ID, status: 'LOCKED' },
  })
  if (!draft) throw new Error('Draft not found or not locked')

  return prisma.tradingTelegramDraft.update({
    where: { id: draftId },
    data: {
      status: 'PENDING',
      lockedAt: null,
      lockedReason: null,
      reviewedBy: reviewerUserId,
      reviewedAt: new Date(),
    },
    include: {
      user: { select: { id: true, name: true, email: true } },
      tradingAccount: { select: { id: true, accountTitle: true } },
    },
  })
}

export function assertDraftEditable(status: string): void {
  if (status === 'LOCKED') {
    throw new Error('Draft is locked — reopen in ERP admin before editing or confirming')
  }
  if (status === 'POSTED') {
    throw new Error('Draft already posted to ledger')
  }
  if (status === 'REJECTED') {
    throw new Error('Draft was rejected')
  }
}

/**
 * Both housekeeping sweeps, throttled.
 *
 * The drafts list is polled every 15s by every open reviewer now, and neither
 * sweep needs that cadence — once a minute per instance keeps a stranded confirm
 * recovering promptly without turning a read into two writes on every poll.
 */
const SWEEP_MIN_INTERVAL_MS = 60_000
let lastSweepAt = 0

export async function sweepTelegramDraftStates(options?: { force?: boolean }): Promise<void> {
  const now = Date.now()
  if (!options?.force && now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return
  lastSweepAt = now
  // Order matters: recover stranded confirms to PENDING first, THEN apply the
  // day-cutoff lock — a recovered draft from an earlier day lands in LOCKED
  // (visible, admin-reopenable) instead of staying invisible.
  await healStuckApprovedTelegramDrafts()
  await lockStalePendingTelegramDrafts()
}
