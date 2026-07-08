import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isPendingActionExpired } from '@/agent/lib/pending-action'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Feed for the iOS "Business Pulse" Live Activity (lock screen + Dynamic Island).
 * Returns today's ALMA Lifestyle order pulse — a count plus a short Bangla status
 * line — and two small "hub" counters: pending approvals awaiting the owner and
 * open agent tasks ("বাকি কাজ"). Owner-only (same auth as
 * /api/assistant/device-reminders).
 *
 * PRIVACY: the lock screen is public, so v1 returns NO money amounts — only
 * counts and the latest order's status. Queries are deliberately cheap: one
 * count + one "latest 1" over an indexed businessId/createdAt window, plus two
 * indexed status counts.
 */

/** Canonical LifestyleOrder statuses → short Bangla for the lock screen. */
function statusToBangla(status: string): string {
  const key = status.trim().toUpperCase().replace(/\s+/g, '_')
  switch (key) {
    case 'PENDING':
      return 'পেন্ডিং'
    case 'CONFIRMED':
      return 'কনফার্মড'
    case 'PACKED':
      return 'প্যাকড'
    case 'SHIPPED':
      return 'শিপড'
    case 'DELIVERED':
      return 'ডেলিভারড'
    case 'CANCELLED':
    case 'CANCELED':
      return 'বাতিল'
    case 'RETURNED':
    case 'RETURNED_PAID':
    case 'RETURNED_UNPAID':
    case 'FAILED_DELIVERY':
      return 'রিটার্ন'
    default:
      return status || 'নতুন'
  }
}

/**
 * Today's Asia/Dhaka (UTC+6, no DST) day window as a UTC [start, end) pair.
 * We derive the Dhaka calendar date from the current instant, then anchor its
 * local midnight (+06:00) and add exactly one day — so "today" always means the
 * owner's local day regardless of the server's UTC clock.
 */
function dhakaTodayWindow(now = new Date()): { start: Date; end: Date } {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const start = new Date(`${ymd}T00:00:00+06:00`)
  const end = new Date(start.getTime() + 86_400_000)
  return { start, end }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { start, end } = dhakaTodayWindow()
  const where = {
    businessId: 'ALMA_LIFESTYLE',
    createdAt: { gte: start, lt: end },
  }

  const [ordersToday, latest, pendingRows, openTasks] = await Promise.all([
    prisma.lifestyleOrder.count({ where }),
    prisma.lifestyleOrder.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
      select: { status: true },
    }),
    // Approvals awaiting the owner — same source of truth as the agent's
    // get_pending_approvals tool (src/agent/tools/erp-tools.ts): status
    // 'pending' (indexed), minus transient cards past their TTL. Lifecycle
    // cards (e.g. dispatch_staff_tasks) never expire — isPendingActionExpired
    // handles that, so we filter the few pending rows in JS exactly like the
    // tool does.
    prisma.agentPendingAction.findMany({
      where: { status: 'pending' },
      select: { type: true, createdAt: true },
    }),
    // Open agent tasks ("বাকি কাজ") — same status filter as countOpenTasks in
    // src/agent/lib/open-task.ts, but across all conversations (hub-wide).
    prisma.agentOpenTask.count({
      where: { businessId: 'ALMA_LIFESTYLE', status: { in: ['open', 'running'] } },
    }),
  ])

  const pendingApprovals = pendingRows.filter(
    (r) => !isPendingActionExpired(r.createdAt, r.type),
  ).length

  const statusLine =
    ordersToday > 0 && latest
      ? `সর্বশেষ: ${statusToBangla(latest.status)}`
      : 'আজ এখনো অর্ডার নেই'

  return Response.json({ ordersToday, statusLine, pendingApprovals, openTasks })
}
