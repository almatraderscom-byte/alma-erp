/**
 * Phase 4 (finance autonomy) — DATA SOURCES for the cash-flow forecast.
 *
 * Thin, read-only DB readers that hand the pure forecast engine
 * (`cashflow-forecast.ts`) exactly the shape it needs: a dated list of upcoming
 * BDT obligations. Kept OUT of the pure module so that core stays unit-testable
 * without a database. No writes, no money movement.
 */
import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import { todayYmdDhaka, dhakaMidnightUtc } from '@/lib/agent-api/dhaka-date'
import type { BillLike, SubscriptionLike } from './cashflow-forecast'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Whole days from today (Dhaka) until the given yyyy-MM-dd date. */
function daysUntilYmd(targetYmd: string | null): number | null {
  if (!targetYmd) return null
  const today = todayYmdDhaka()
  return Math.round((dhakaMidnightUtc(targetYmd).getTime() - dhakaMidnightUtc(today).getTime()) / 86400000)
}

/** Active tracked bills, shaped for the forecast (name, whole-taka amount, currency, daysUntil). */
export async function listBillsForForecast(): Promise<BillLike[]> {
  const rows = await db.agentBill.findMany({
    where: { active: true },
    orderBy: [{ nextDueAt: 'asc' }],
    take: 200,
  })
  return rows.map(
    (b: { name: string; amount: number; currency: string | null; nextDueAt: Date | null }) => {
      const dueYmd = b.nextDueAt ? new Date(b.nextDueAt).toISOString().slice(0, 10) : null
      return {
        name: b.name,
        amount: roundMoney(b.amount),
        currency: b.currency || 'BDT',
        daysUntil: daysUntilYmd(dueYmd),
      }
    },
  )
}

/** Active subscriptions, shaped for the forecast. Amount is Decimal in DB → number. */
export async function listSubscriptionsForForecast(): Promise<SubscriptionLike[]> {
  const rows = await db.agentSubscription.findMany({
    where: { active: true },
    orderBy: [{ nextRenewalAt: 'asc' }],
    take: 200,
  })
  return rows.map(
    (s: { name: string; amount: unknown; currency: string | null; nextRenewalAt: Date }) => {
      const renewYmd = s.nextRenewalAt ? new Date(s.nextRenewalAt).toISOString().slice(0, 10) : null
      return {
        name: s.name,
        amount: roundMoney(Number(s.amount)),
        currency: s.currency || 'USD',
        daysUntil: daysUntilYmd(renewYmd),
      }
    },
  )
}
