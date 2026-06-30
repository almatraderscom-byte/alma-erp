/**
 * Win-back + content-refresh auto-proposals (owner-gated, no LLM needed).
 *
 * The data already existed (customer-intelligence winBack segment + content-
 * intelligence staleProducts) but nothing turned it into a PROPOSAL the owner
 * could act on. This deterministically surfaces two weekly nudges as owner-gated
 * pending actions + a Telegram heads-up — it only PROPOSES, never acts. Mirrors
 * the strategist/reflection delivery pattern. Deduped so a still-pending proposal
 * isn't re-created every week.
 */
import { prisma } from '@/lib/prisma'
import { notifyOwner } from '@/agent/lib/notify-owner'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { segmentCustomers } from '@/lib/customer-intelligence'
import { buildMarketingIntel } from '@/lib/content-intelligence'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const BUSINESS_ID = 'ALMA_LIFESTYLE'
const WINBACK_MIN = 5
const WINBACK_LAPSE_DAYS = 30
const STALE_MIN_DAYS = 21

async function alreadyPending(type: string): Promise<boolean> {
  try {
    const row = await db.agentPendingAction.findFirst({ where: { type, status: 'pending' }, select: { id: true } })
    return !!row
  } catch {
    return false
  }
}

export async function runWinbackContentNudge(): Promise<{ winback: number; stale: number; proposed: number }> {
  let proposed = 0
  let winbackCount = 0
  let staleCount = 0

  // ── 1. Win-back: customers who have lapsed ──────────────────────────────────
  try {
    const seg = await segmentCustomers()
    const winBack = (seg.winBack ?? []).filter((c) => (c.daysSinceLastOrder ?? 0) >= WINBACK_LAPSE_DAYS)
    winbackCount = winBack.length
    if (winBack.length >= WINBACK_MIN && !(await alreadyPending('winback_proposal'))) {
      const top = winBack.slice(0, 8)
      const names = top.map((c) => c.name || c.phone || 'কাস্টমার').slice(0, 5).join(', ')
      const summary = `🔄 ${winBack.length} জন কাস্টমার ${WINBACK_LAPSE_DAYS}+ দিন অর্ডার করেননি (যেমন: ${names})। একটা win-back অফার/মেসেজ পাঠাবেন?`
      await db.agentPendingAction.create({
        data: {
          type: 'winback_proposal',
          payload: {
            count: winBack.length,
            customers: top.map((c) => ({ id: c.id, name: c.name, phone: c.phone, days: c.daysSinceLastOrder })),
            date: todayYmdDhaka(),
          },
          summary,
          status: 'pending',
          businessId: BUSINESS_ID,
        },
      })
      await notifyOwner({ tier: 2, title: 'Win-back সুযোগ', message: summary, category: 'report' })
      void sendOwnerText(summary).catch(() => {})
      proposed++
    }
  } catch (err) {
    console.warn('[winback] segment failed:', err instanceof Error ? err.message : String(err))
  }

  // ── 2. Content refresh: products that haven't been promoted in a while ──────
  try {
    const intel = await buildMarketingIntel()
    const stale = (intel.staleProducts ?? []).filter((s) => s.daysSincePromo >= STALE_MIN_DAYS)
    staleCount = stale.length
    if (stale.length >= 1 && !(await alreadyPending('content_refresh'))) {
      const top = stale.slice(0, 6)
      const list = top.map((s) => `${s.productRef} (${s.daysSincePromo}দিন)`).join(', ')
      const summary = `📣 ${stale.length}টি product অনেকদিন প্রমোট হয়নি: ${list}। নতুন কন্টেন্ট/পোস্ট বানাবেন?`
      await db.agentPendingAction.create({
        data: {
          type: 'content_refresh',
          payload: { count: stale.length, products: top, date: todayYmdDhaka() },
          summary,
          status: 'pending',
          businessId: BUSINESS_ID,
        },
      })
      await notifyOwner({ tier: 2, title: 'কন্টেন্ট রিফ্রেশ', message: summary, category: 'report' })
      void sendOwnerText(summary).catch(() => {})
      proposed++
    }
  } catch (err) {
    console.warn('[winback] content failed:', err instanceof Error ? err.message : String(err))
  }

  return { winback: winbackCount, stale: staleCount, proposed }
}
