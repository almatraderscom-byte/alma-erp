import { prisma } from '@/lib/prisma'

export interface CustomerInfo {
  id: string
  name?: string | null
  phone?: string | null
  ordersCount: number
  lastOrderAt?: Date | null
  daysSinceLastOrder?: number | null
}

export interface CustomerSegmentResult {
  winBack: CustomerInfo[]
  loyal: CustomerInfo[]
  atRisk: CustomerInfo[]
  newRecent: CustomerInfo[]
}

const DAY = 86_400_000

function withDaysSince(
  customers: Array<{
    id: string
    name: string | null
    phone: string | null
    ordersCount: number
    lastOrderAt: Date | null
  }>,
  now: number,
): CustomerInfo[] {
  return customers.map((c) => ({
    ...c,
    daysSinceLastOrder: c.lastOrderAt
      ? Math.floor((now - c.lastOrderAt.getTime()) / DAY)
      : null,
  }))
}

export async function segmentCustomers(): Promise<CustomerSegmentResult> {
  const customers = await prisma.csCustomer.findMany({
    select: {
      id: true,
      name: true,
      phone: true,
      ordersCount: true,
      lastOrderAt: true,
    },
  })

  const now = Date.now()
  const withDays = withDaysSince(customers, now)

  const winBack = withDays
    .filter(
      (c) =>
        c.ordersCount >= 2 &&
        c.daysSinceLastOrder != null &&
        c.daysSinceLastOrder >= 45 &&
        c.daysSinceLastOrder <= 180,
    )
    .sort((a, b) => (b.ordersCount - a.ordersCount) || ((b.daysSinceLastOrder ?? 0) - (a.daysSinceLastOrder ?? 0)))

  const loyal = withDays
    .filter((c) => c.ordersCount >= 3)
    .sort((a, b) => b.ordersCount - a.ordersCount)
    .slice(0, 20)

  const atRisk = withDays
    .filter(
      (c) =>
        c.ordersCount >= 3 &&
        c.daysSinceLastOrder != null &&
        c.daysSinceLastOrder >= 30 &&
        c.daysSinceLastOrder < 45,
    )
    .sort((a, b) => (b.ordersCount - a.ordersCount) || ((b.daysSinceLastOrder ?? 0) - (a.daysSinceLastOrder ?? 0)))

  const newRecent = withDays
    .filter(
      (c) =>
        c.ordersCount === 1 &&
        c.daysSinceLastOrder != null &&
        c.daysSinceLastOrder <= 14,
    )
    .sort((a, b) => (a.daysSinceLastOrder ?? 0) - (b.daysSinceLastOrder ?? 0))

  return { winBack, loyal, atRisk, newRecent }
}

/** JSON-safe segment payload for internal API / worker. */
export async function segmentCustomersForApi() {
  const seg = await segmentCustomers()
  const serialize = (list: CustomerInfo[]) =>
    list.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      ordersCount: c.ordersCount,
      lastOrderAt: c.lastOrderAt?.toISOString() ?? null,
      daysSinceLastOrder: c.daysSinceLastOrder,
    }))

  return {
    winBack: serialize(seg.winBack),
    loyal: serialize(seg.loyal),
    atRisk: serialize(seg.atRisk),
    newRecent: serialize(seg.newRecent),
    winBackCount: seg.winBack.length,
    loyalCount: seg.loyal.length,
    atRiskCount: seg.atRisk.length,
    newRecentCount: seg.newRecent.length,
  }
}
