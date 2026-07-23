/**
 * Durable owner notification for a completed web/app Agent turn.
 *
 * The completion is persisted before OneSignal is called. A lease makes retries
 * safe across overlapping Vercel/worker invocations, and the stable turn id is
 * sent as OneSignal's collapse/delivery id to de-duplicate an uncertain retry.
 */
import { prisma } from '@/lib/prisma'
import { isOwnerAppActive } from '@/agent/lib/owner-presence'
import { pushNativeToOwner } from '@/agent/lib/native-owner-push'

const LEASE_MS = 60_000
const MAX_ATTEMPTS = 8
const RETRY_DELAYS_MS = [
  15_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
]

function cleanPreview(value: string | null | undefined): string {
  const compact = (value ?? '').replace(/\s+/g, ' ').trim()
  return (compact || 'আপনার কাজ শেষ হয়েছে Boss।').slice(0, 220)
}

export async function enqueueTurnCompletionNotification(input: {
  turnId: string
  conversationId: string
  preview?: string | null
}): Promise<string> {
  const row = await prisma.agentTurnNotificationDelivery.upsert({
    where: { turnId: input.turnId },
    create: {
      turnId: input.turnId,
      conversationId: input.conversationId,
      preview: cleanPreview(input.preview),
    },
    // A replay may improve the preview, but must never re-arm a terminal row.
    update: {
      conversationId: input.conversationId,
      preview: cleanPreview(input.preview),
    },
    select: { id: true },
  })
  return row.id
}

async function claimDelivery(deliveryId?: string) {
  const now = new Date()
  const claimable = {
    OR: [
      { status: { in: ['pending', 'retry'] }, availableAt: { lte: now } },
      { status: 'processing', leaseUntil: { lt: now } },
    ],
  }

  const candidate = await prisma.agentTurnNotificationDelivery.findFirst({
    where: {
      ...(deliveryId ? { id: deliveryId } : {}),
      ...claimable,
    },
    orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
    select: { id: true },
  })
  if (!candidate) return null

  const claimed = await prisma.agentTurnNotificationDelivery.updateMany({
    where: { id: candidate.id, ...claimable },
    data: {
      status: 'processing',
      attempts: { increment: 1 },
      leaseUntil: new Date(Date.now() + LEASE_MS),
      lastError: null,
    },
  })
  if (claimed.count !== 1) return null
  return prisma.agentTurnNotificationDelivery.findUnique({ where: { id: candidate.id } })
}

async function finishDelivery(
  id: string,
  status: 'delivered' | 'suppressed' | 'retry' | 'dead',
  lastError?: string,
  attempts = 1,
): Promise<void> {
  const terminal = status === 'delivered' || status === 'suppressed' || status === 'dead'
  const delay = RETRY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1)]
  await prisma.agentTurnNotificationDelivery.update({
    where: { id },
    data: {
      status,
      leaseUntil: null,
      deliveredAt: terminal ? new Date() : null,
      lastError: lastError?.slice(0, 1000) ?? null,
      ...(status === 'retry' ? { availableAt: new Date(Date.now() + delay) } : {}),
    },
  })
}

/**
 * Deliver one row. Returns false only when no claimable row existed.
 */
export async function deliverTurnCompletionNotification(deliveryId?: string): Promise<boolean> {
  const row = await claimDelivery(deliveryId)
  if (!row) return false

  try {
    // The owner can already see the completed reply. This is a deliberate,
    // terminal suppression—not a transient delivery failure.
    if (await isOwnerAppActive()) {
      await finishDelivery(row.id, 'suppressed', 'owner_app_active', row.attempts)
      return true
    }

    const result = await pushNativeToOwner({
      tier: 2,
      title: 'ALMA Agent — কাজ শেষ',
      message: cleanPreview(row.preview),
      category: 'task',
      actionUrl: '/agent',
      notificationKind: 'completion',
      deliveryId: row.turnId,
    })

    if (result.ok) {
      await finishDelivery(row.id, 'delivered', undefined, row.attempts)
      return true
    }

    // Explicit product/user controls are stable terminal decisions. Missing
    // config, transport errors, or a temporarily missing subscription are retried.
    if (result.reason === 'disabled' || result.reason === 'disabled_by_user') {
      await finishDelivery(row.id, 'suppressed', result.reason, row.attempts)
      return true
    }

    const terminal = row.attempts >= MAX_ATTEMPTS
    await finishDelivery(
      row.id,
      terminal ? 'dead' : 'retry',
      result.reason ?? 'native_push_failed',
      row.attempts,
    )
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const terminal = row.attempts >= MAX_ATTEMPTS
    await finishDelivery(row.id, terminal ? 'dead' : 'retry', message, row.attempts)
    return true
  }
}

/** Lease and deliver a bounded batch; called by the VPS sweeper. */
export async function processDueTurnCompletionNotifications(limit = 20): Promise<{
  processed: number
}> {
  const bounded = Math.max(1, Math.min(limit, 50))
  let processed = 0
  while (processed < bounded && await deliverTurnCompletionNotification()) processed += 1
  return { processed }
}
