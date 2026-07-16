/**
 * "Business Pulse" Dynamic Panel — server-side snapshot builder.
 *
 * Turns live ERP state into the single authoritative PulseSnapshot that both
 * the polling route (/api/assistant/live-pulse) and the ActivityKit push
 * service render. The UI never invents priority — it renders what this returns
 * (spec §5).
 *
 * GROUNDED IN THE REAL DATA, not the spec's illustrative examples:
 *   • ALMA Lifestyle has NO packed/shipped fulfilment stage. The real order
 *     pipeline is Pending → Confirmed → Delivered, so "running orders" means
 *     Pending + Confirmed and progress is the share already Confirmed. We never
 *     render a courier/packed stage that does not exist.
 *   • Order statuses are case-inconsistent in the DB ('Cancelled' AND
 *     'CANCELLED', 'Pending', 'RETURNED_PAID'), so every comparison here is
 *     case-folded. A case-sensitive `status: { in: [...] }` would silently
 *     undercount.
 *   • The urgent signal is a stock MISMATCH (available < 0 — sold more than
 *     exists), which is rare and genuinely wrong. Low stock is `attention`, not
 *     urgent, so the panel does not sit permanently red.
 *
 * Every query is cheap and indexed: the panel is polled.
 */
import { prisma } from '@/lib/prisma'
import { isPendingActionExpired } from '@/agent/lib/pending-action'
import {
  alertKeyFor,
  clampCount,
  clampProgress,
  copyForMode,
  formatTakaBn,
  selectPulseMode,
  toBanglaDigits,
  topPulseItems,
  type PulseApproval,
  type PulseAlert,
  type PulseItem,
  type PulseSnapshot,
} from '@/lib/pulse-state'

const BUSINESS_ID = 'ALMA_LIFESTYLE'

/** How long a snapshot is considered current before the panel self-marks stale. */
export const PULSE_STALE_AFTER_MS = 15 * 60_000

/** Order statuses that mean "still in flight" (case-folded). */
const RUNNING_STATUSES = new Set(['pending', 'confirmed'])
/** In-flight statuses that have cleared the first gate — drives progress. */
const ADVANCED_STATUSES = new Set(['confirmed'])

/** Canonical LifestyleOrder statuses → short Bangla. */
function statusToBangla(status: string): string {
  switch (status.trim().toUpperCase().replace(/\s+/g, '_')) {
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

/** Short Bangla label for an approval card type — never the raw enum (spec §4). */
function approvalKindBangla(type: string): string {
  switch (type) {
    case 'log_ledger_entry':
      return 'লেজার এন্ট্রি'
    case 'dispatch_staff_tasks':
      return 'স্টাফ টাস্ক'
    case 'outbound_call':
    case 'agent_voice_call':
      return 'কল'
    case 'delegation':
      return 'কাজ ভাগ'
    case 'auto_fix':
      return 'অটো-ফিক্স'
    case 'image_gen':
      return 'ছবি তৈরি'
    case 'staff_auto_message':
      return 'স্টাফ মেসেজ'
    case 'office_absence_confirm':
      return 'অফিস উপস্থিতি'
    case 'duty_approval_block':
      return 'ডিউটি অনুমোদন'
    case 'urgent_notify':
      return 'জরুরি নোটিশ'
    default:
      return 'অনুমোদন'
  }
}

/**
 * First meaningful line of an approval summary, stripped of emoji + markdown
 * so it fits one lock-screen line. Summaries are multi-line Bangla with
 * decoration ("🌙 *আগামীকাল ...*") — the panel needs the plain first line.
 */
function firstLine(summary: string, max = 48): string {
  const line = (summary || '')
    .split('\n')
    .map((l) => l.replace(/[*_`#]/g, '').trim())
    // Drop leading emoji/pictographs and separator junk.
    .map((l) => l.replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\s✅⏳📞📋🎨🔧⚡🌙🌟]+/gu, '').trim())
    .find((l) => l.length > 0)
  const clean = line || 'অনুমোদন দরকার'
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

type PendingRow = {
  id: string
  type: string
  summary: string
  payload: unknown
  costEstimate: number | null
  createdAt: Date
}

/**
 * Structured approval summary from a pending-action row. Only uses fields that
 * really exist — `log_ledger_entry` carries {personName, amount, currency};
 * other types fall back to the costEstimate column. Nothing is invented.
 */
function toApproval(row: PendingRow): PulseApproval {
  const payload = (row.payload ?? {}) as Record<string, unknown>
  const personName = typeof payload.personName === 'string' ? payload.personName.trim() : ''
  const rawAmount = typeof payload.amount === 'number' ? payload.amount : row.costEstimate
  const currency = typeof payload.currency === 'string' ? payload.currency.toUpperCase() : 'BDT'

  let amountText: string | undefined
  if (typeof rawAmount === 'number' && Number.isFinite(rawAmount) && rawAmount !== 0) {
    amountText =
      currency === 'BDT'
        ? formatTakaBn(rawAmount)
        : `${toBanglaDigits(Math.round(Math.abs(rawAmount)))} ${currency}`
  }

  return {
    id: row.id,
    title: firstLine(row.summary),
    counterparty: personName || approvalKindBangla(row.type),
    amountText,
    reference: undefined,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Build the authoritative panel snapshot. `isOffline`/`isStale` are deliberately
 * absent: the server cannot observe its own unreachability, and staleness is
 * derived natively from `staleAfter` via ActivityKit's own isStale.
 */
export async function buildPulseSnapshot(now: Date = new Date()): Promise<PulseSnapshot> {
  const { start, end } = dhakaTodayWindow(now)
  const todayWhere = { businessId: BUSINESS_ID, createdAt: { gte: start, lt: end } }

  const [ordersToday, latest, pendingRows, taskRows, orderStatusRows, mismatch] = await Promise.all([
    prisma.lifestyleOrder.count({ where: todayWhere }),
    prisma.lifestyleOrder.findFirst({
      where: todayWhere,
      orderBy: { createdAt: 'desc' },
      select: { status: true },
    }),
    // Approvals awaiting the owner — same source of truth as the agent's
    // get_pending_approvals tool: status 'pending' (indexed), minus transient
    // cards past their TTL (lifecycle cards never expire).
    prisma.agentPendingAction.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, type: true, summary: true, payload: true, costEstimate: true, createdAt: true },
    }),
    // Open agent tasks — split by status so we can tell "waiting" from "running".
    prisma.agentOpenTask.groupBy({
      by: ['status'],
      where: { businessId: BUSINESS_ID, status: { in: ['open', 'running'] } },
      _count: { _all: true },
    }),
    // All order statuses at once (uses @@index([businessId, status])); we fold
    // case in JS because the DB holds mixed-case variants of the same status.
    prisma.lifestyleOrder.groupBy({
      by: ['status'],
      where: { businessId: BUSINESS_ID },
      _count: { _all: true },
    }),
    // Stock mismatch = sold more than exists. Rare, real, genuinely urgent.
    prisma.lifestyleStockItem.findMany({
      where: { active: true, archived: false, available: { lt: 0 } },
      orderBy: { available: 'asc' },
      select: { sku: true, product: true, available: true },
      take: 1,
    }),
  ])

  const pending = pendingRows.filter((r) => !isPendingActionExpired(r.createdAt, r.type))
  const approvalCount = pending.length
  const approval = pending[0] ? toApproval(pending[0] as PendingRow) : undefined

  const runningTaskCount = clampCount(
    taskRows.find((r) => r.status === 'running')?._count._all ?? 0,
  )
  const pendingTaskCount = clampCount(taskRows.reduce((sum, r) => sum + r._count._all, 0))

  let runningOrderCount = 0
  let advancedOrderCount = 0
  for (const row of orderStatusRows) {
    const key = row.status.trim().toLowerCase()
    if (!RUNNING_STATUSES.has(key)) continue
    runningOrderCount += row._count._all
    if (ADVANCED_STATUSES.has(key)) advancedOrderCount += row._count._all
  }
  runningOrderCount = clampCount(runningOrderCount)
  const waitingOrderCount = clampCount(runningOrderCount - advancedOrderCount)
  const orderProgress =
    runningOrderCount > 0 ? clampProgress(advancedOrderCount / runningOrderCount) : undefined

  const bad = mismatch[0]
  const urgentAlert: PulseAlert | undefined = bad
    ? {
        id: `stock:${bad.sku}`,
        title: 'স্টক গরমিল ধরা পড়েছে',
        detail: `${bad.sku} · ${toBanglaDigits(Math.abs(bad.available))} পিস মিলছে না`,
        severity: 'urgent',
      }
    : undefined

  const mode = selectPulseMode({
    hasUrgentAlert: Boolean(urgentAlert),
    hasBlockingApproval: approvalCount > 0,
    runningOrderCount,
    hasRunningJob: runningTaskCount > 0,
  })

  const copy = copyForMode(mode, {
    pendingTaskCount,
    approvalCount,
    runningOrderCount,
    urgentAlert,
    approval,
  })

  // The orders subtitle names the REAL breakdown — never "packed / courier".
  const subtitle =
    mode === 'orders' && runningOrderCount > 0
      ? `${toBanglaDigits(advancedOrderCount)} কনফার্মড · ${toBanglaDigits(waitingOrderCount)} পেন্ডিং`
      : copy.subtitle

  const items = topPulseItems(
    buildItems({ approval, urgentAlert, runningOrderCount, advancedOrderCount, waitingOrderCount, orderProgress, pendingTaskCount, now }),
  )

  return {
    mode,
    headline: copy.headline,
    subtitle,
    pendingTaskCount,
    approvalCount,
    runningOrderCount,
    orderProgress,
    items,
    lastUpdatedAt: now.toISOString(),
    staleAfter: new Date(now.getTime() + PULSE_STALE_AFTER_MS).toISOString(),
    approval,
    urgentAlert,
    alertKey: alertKeyFor({ mode, urgentAlert, approval }),
    // Legacy v1/v2 fields — an older native build reads only these.
    ordersToday: clampCount(ordersToday),
    statusLine:
      ordersToday > 0 && latest ? `সর্বশেষ: ${statusToBangla(latest.status)}` : 'আজ এখনো অর্ডার নেই',
    pendingApprovals: approvalCount,
    openTasks: pendingTaskCount,
  }
}

/**
 * Deep links (spec §16) — mapped to the routes this app ACTUALLY has.
 *
 * The spec's scheme (`almaerp://approvals/{id}`, `almaerp://orders/running`,
 * `almaerp://tasks/pending`) was written for an imagined ERP: none of those
 * routes exist here, so every one of them would 404. DeepLinkManager turns
 * `almaerp://<host><path><query>` into `/<host><path><query>`, so a link is only
 * real if that Next.js route is real. What exists:
 *   • /inventory?q=…  — search IS supported, so a stock alert can open the exact
 *                       SKU. This is the only genuinely per-record link.
 *   • /orders         — list only (no /orders/running, no [id] route).
 *   • /agent          — the hub where the agent's approval cards and "বাকি কাজ"
 *                       chips actually live and are actioned. /approvals exists
 *                       but opens its *business* tab (the agent tab is local
 *                       state, not URL-driven), so it would land the owner in
 *                       the wrong place — and making it URL-driven would mean
 *                       editing a live ERP screen, which this work must not do.
 */
const LINK_ORDERS = 'almaerp://orders'
const LINK_AGENT_HUB = 'almaerp://agent'

/** The notification-style feed rows, before ranking/trimming to three. */
function buildItems(a: {
  approval?: PulseApproval
  urgentAlert?: PulseAlert
  runningOrderCount: number
  advancedOrderCount: number
  waitingOrderCount: number
  orderProgress?: number
  pendingTaskCount: number
  now: Date
}): PulseItem[] {
  const items: PulseItem[] = []
  const iso = a.now.toISOString()

  if (a.urgentAlert) {
    const sku = a.urgentAlert.id.replace(/^stock:/, '')
    items.push({
      id: a.urgentAlert.id,
      kind: 'stockAlert',
      title: a.urgentAlert.title,
      subtitle: a.urgentAlert.detail,
      severity: 'urgent',
      createdAt: iso,
      // The one true per-record link we have: /inventory supports ?q= search.
      link: `almaerp://inventory?q=${encodeURIComponent(sku)}`,
    })
  }

  if (a.approval) {
    items.push({
      id: a.approval.id,
      kind: 'approval',
      title: a.approval.title,
      subtitle: a.approval.counterparty,
      valueText: a.approval.amountText,
      severity: 'attention',
      createdAt: a.approval.createdAt,
      link: LINK_AGENT_HUB,
    })
  }

  if (a.runningOrderCount > 0) {
    items.push({
      id: 'orders:running',
      kind: 'orderProgress',
      title: `${toBanglaDigits(a.runningOrderCount)}টি অর্ডার চলছে`,
      subtitle: `${toBanglaDigits(a.advancedOrderCount)} কনফার্মড · ${toBanglaDigits(a.waitingOrderCount)} পেন্ডিং`,
      valueText: `${toBanglaDigits(a.runningOrderCount)}`,
      progress: a.orderProgress,
      severity: 'normal',
      createdAt: iso,
      link: LINK_ORDERS,
    })
  }

  if (a.pendingTaskCount > 0) {
    items.push({
      id: 'tasks:pending',
      kind: 'pendingTask',
      title: 'বাকি কাজ',
      subtitle: `${toBanglaDigits(a.pendingTaskCount)}টি কাজ অপেক্ষায়`,
      valueText: `${toBanglaDigits(a.pendingTaskCount)}`,
      severity: 'normal',
      createdAt: iso,
      link: LINK_AGENT_HUB,
    })
  }

  return items
}

/**
 * Today's Asia/Dhaka (UTC+6, no DST) day window as a UTC [start, end) pair, so
 * "today" always means the owner's local day regardless of the server clock.
 */
export function dhakaTodayWindow(now = new Date()): { start: Date; end: Date } {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const start = new Date(`${ymd}T00:00:00+06:00`)
  return { start, end: new Date(start.getTime() + 86_400_000) }
}
