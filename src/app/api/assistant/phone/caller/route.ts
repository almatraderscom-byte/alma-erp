/**
 * GET /api/assistant/phone/caller?number=… — screen-pop for the browser softphone.
 *
 * The instant a call arrives, whoever answers should already see who is calling and what
 * they are likely calling about. "Who is this and what do they want" is what makes a support
 * call stressful, and every fact needed to answer it is already in the ERP.
 *
 * Matched on the last 10 digits, so +8801…, 8801… and 01… all find the same person.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ found: false, error: 'unauthenticated' }, { status: 401 })

  const raw = new URL(req.url).searchParams.get('number') ?? ''
  const tail = raw.replace(/\D/g, '').slice(-10)
  if (tail.length < 9) return NextResponse.json({ found: false })

  try {
    // `phone` is stored in assorted formats across years of data, so match on the suffix.
    const customer = await db.lifestyleCustomer.findFirst({
      where: { phone: { endsWith: tail } },
      select: { name: true, phone: true, totalOrders: true, totalSpent: true, pending: true, segment: true, riskLevel: true },
    })

    const lastOrder = await db.lifestyleOrder.findFirst({
      where: { phone: { endsWith: tail } },
      orderBy: { createdAt: 'desc' },
      select: { orderNumber: true, status: true, createdAt: true, total: true },
    }).catch(() => null)

    // How often this number has called recently — a third call in a week is a different
    // conversation from a first one, and the person answering should know that.
    const recentCalls = await db.agentVoiceCall.count({
      where: {
        toNumber: { endsWith: tail },
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60_000) },
      },
    }).catch(() => 0)

    if (!customer && !lastOrder) return NextResponse.json({ found: false, recentCalls })

    return NextResponse.json({
      found: true,
      name: customer?.name ?? null,
      totalOrders: customer?.totalOrders ?? 0,
      // "Due" here is the pending-order count's value the staff most often needs; total spent
      // is shown separately in the panel's history if needed.
      dueAmount: customer?.pending ? (lastOrder?.total ?? 0) : 0,
      segment: customer?.segment ?? null,
      riskLevel: customer?.riskLevel ?? null,
      recentCalls,
      lastOrder: lastOrder
        ? {
            number: lastOrder.orderNumber ?? undefined,
            status: lastOrder.status ?? undefined,
            date: lastOrder.createdAt
              ? new Date(lastOrder.createdAt).toLocaleDateString('bn-BD', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'long' })
              : undefined,
          }
        : undefined,
    })
  } catch (err) {
    console.warn('[phone/caller] lookup failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ found: false })
  }
}
