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

const STRANDED_CONFIRM_MESSAGE =
  'Confirm did not finish — the trade was never written. Try Confirm again.'

/**
 * Recover ONE stranded draft, used on the confirm path so a retry does not have
 * to wait for the periodic sweep.
 *
 * The staleness predicate lives in the WHERE clause, so a confirm that is still
 * running cannot be stolen out from under itself: the update simply matches
 * nothing and the caller's claim then fails, which is the correct answer.
 */
export async function recoverStrandedApprovedDraft(draftId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - STUCK_APPROVED_GRACE_MS)
  const result = await prisma.tradingTelegramDraft.updateMany({
    where: {
      id: draftId,
      businessId: TRADING_BUSINESS_ID,
      status: 'APPROVED',
      tradingTradeId: null,
      OR: [{ reviewedAt: { lt: staleBefore } }, { reviewedAt: null }],
    },
    data: { status: 'PENDING', confirmError: STRANDED_CONFIRM_MESSAGE, confirmErrorAt: new Date() },
  })
  return result.count > 0
}

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
    select: { id: true, telegramUserId: true, telegramChatId: true, reviewedBy: true },
    take: 100,
  })
  if (!stuck.length) return 0

  // Recover — and log — ONE ROW AT A TIME. Two polls on separate serverless
  // instances can read the same stuck row; a bulk update tells you how many
  // changed but not which, so both instances would write a
  // DRAFT_CONFIRM_RECOVERED event for a row only one of them actually moved.
  // The per-row update returns a count that answers "did *I* move this one".
  let recovered = 0
  for (const draft of stuck) {
    if (!(await recoverStrandedApprovedDraft(draft.id))) continue
    recovered += 1
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

  return recovered
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

/**
 * The `createdAt` predicate that makes a claim obey the day cutoff ATOMICALLY.
 *
 * Recovering a stranded draft, sweeping the cutoff and claiming were three
 * statements, so two retries on the same prior-day draft could interleave: the
 * first recovers it to PENDING and pauses, the second sees PENDING, skips
 * recovery and claims it before the sweep locks it — walking past the
 * admin-reopen control anyway. Folding the rule into the claim's WHERE removes
 * the gap: past the cutoff, only a draft created today is claimable at all.
 *
 * Returns undefined before the cutoff hour, when every pending draft is fair
 * game.
 */
export function claimableCreatedAtFilter(): { gte: Date } | undefined {
  const now = tradingBdNow()
  if (now.getUTCHours() < telegramDraftLockHourBd()) return undefined
  return { gte: tradingBdDayBounds(now).start }
}
