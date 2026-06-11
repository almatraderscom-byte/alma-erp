/**
 * Rate limits for send_urgent_alert — tier 2: 5/hour, tier 3: 2/day.
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function checkUrgentRateLimit(tier: 2 | 3): Promise<{ ok: boolean; error?: string; remaining?: number }> {
  const windowMs = tier === 2 ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000
  const limit = tier === 2 ? 5 : 2
  const since = new Date(Date.now() - windowMs)

  const count = await db.agentNotification.count({
    where: {
      tier,
      createdAt: { gte: since },
    },
  })

  if (count >= limit) {
    const windowLabel = tier === 2 ? '১ ঘণ্টায়' : 'আজ'
    return {
      ok: false,
      error: `Rate limit: tier ${tier} সর্বোচ্চ ${limit} বার ${windowLabel} (${count}/${limit} used)`,
      remaining: 0,
    }
  }

  return { ok: true, remaining: limit - count }
}
