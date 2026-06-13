/**
 * Rate limits for send_urgent_alert / outbound calls.
 * tier 2: 5/hour | tier 3 urgent (excl. salah): 5/24h | outbound_call actions: 5/24h
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const WINDOW_24H_MS = 24 * 60 * 60 * 1000
const TIER3_URGENT_LIMIT = 5
const OUTBOUND_CALL_LIMIT = 5

export async function checkUrgentRateLimit(tier: 2 | 3): Promise<{ ok: boolean; error?: string; remaining?: number }> {
  const windowMs = tier === 2 ? 60 * 60 * 1000 : WINDOW_24H_MS
  const limit = tier === 2 ? 5 : TIER3_URGENT_LIMIT
  const since = new Date(Date.now() - windowMs)

  const where =
    tier === 3
      ? {
          tier: 3,
          createdAt: { gte: since },
          NOT: { category: 'salah' },
        }
      : {
          tier: 2,
          createdAt: { gte: since },
        }

  const count = await db.agentNotification.count({ where })

  if (count >= limit) {
    const windowLabel = tier === 2 ? '১ ঘণ্টায়' : '২৪ ঘণ্টায়'
    return {
      ok: false,
      error: `Rate limit: tier ${tier} সর্বোচ্চ ${limit} বার ${windowLabel} (${count}/${limit} used)`,
      remaining: 0,
    }
  }

  return { ok: true, remaining: limit - count }
}

/** Owner-initiated outbound_phone_call — separate from salah auto-calls. */
export async function checkOutboundCallRateLimit(): Promise<{ ok: boolean; error?: string; remaining?: number }> {
  const since = new Date(Date.now() - WINDOW_24H_MS)
  const count = await db.agentPendingAction.count({
    where: {
      type: 'outbound_call',
      createdAt: { gte: since },
      status: { notIn: ['cancelled', 'rejected'] },
    },
  })

  if (count >= OUTBOUND_CALL_LIMIT) {
    return {
      ok: false,
      error: `Rate limit: outbound call সর্বোচ্চ ${OUTBOUND_CALL_LIMIT} বার ২৪ ঘণ্টায় (${count}/${OUTBOUND_CALL_LIMIT} used)`,
      remaining: 0,
    }
  }

  return { ok: true, remaining: OUTBOUND_CALL_LIMIT - count }
}
