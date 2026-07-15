/**
 * "Business Pulse" Dynamic Panel — shared domain layer.
 *
 * This module is the single source of truth for WHAT the iOS Live Activity /
 * Dynamic Island shows: the mode priority engine, the value clamps, the alert
 * dedupe keys and the owner-facing Bangla copy.
 *
 * It is deliberately PURE — no prisma, no fetch, no agent imports — so that:
 *   • the server route + cron push service both derive an identical snapshot
 *     (the UI must never invent its own priority — see spec §5), and
 *   • ERP code may import it without violating the one-way agent dependency
 *     rule (CLAUDE.md #4), and
 *   • every branch is unit-testable.
 *
 * Data gathering lives in src/agent/lib/pulse-snapshot.ts; the native renderer
 * mirrors these modes in ios/App/App/PulseActivityAttributes.swift.
 */

/** Panel modes, highest priority first — mirrors PulseMode in Swift. */
export type PulseMode =
  | 'urgent'
  | 'approval'
  | 'orders'
  | 'working'
  | 'stale'
  | 'offline'
  | 'success'
  | 'overview'

export type PulseSeverity = 'normal' | 'attention' | 'urgent'

export type PulseItemKind =
  | 'approval'
  | 'orderProgress'
  | 'pendingTask'
  | 'stockAlert'
  | 'paymentAlert'
  | 'deliveryAlert'
  | 'system'

/** One notification-style row in the Live Activity feed (max 3 are sent). */
export interface PulseItem {
  id: string
  kind: PulseItemKind
  title: string
  subtitle: string
  /** Short trailing value — a count, or an amount when the owner allows it. */
  valueText?: string
  /** 0…1 when this row shows a progress line. */
  progress?: number
  severity: PulseSeverity
  /** ISO-8601. */
  createdAt: string
  /** almaerp:// destination for a tap. */
  link?: string
}

export interface PulseApproval {
  id: string
  title: string
  counterparty: string
  /** Pre-formatted (e.g. "৳৪৮,৫০০"). Rendered privacy-sensitive on iOS. */
  amountText?: string
  reference?: string
  createdAt: string
}

export interface PulseAlert {
  id: string
  title: string
  detail: string
  severity: PulseSeverity
}

export interface PulseSuccess {
  title: string
  detail: string
  completedAt: string
}

/** The full panel payload. Everything the native side needs, nothing more. */
export interface PulseSnapshot {
  mode: PulseMode
  headline: string
  subtitle: string
  pendingTaskCount: number
  approvalCount: number
  runningOrderCount: number
  orderProgress?: number
  items: PulseItem[]
  /** ISO-8601, server clock (spec §4: lastUpdatedAt must come from the server). */
  lastUpdatedAt: string
  /** ISO-8601 — after this the panel renders itself as "may be out of date". */
  staleAfter: string
  approval?: PulseApproval
  urgentAlert?: PulseAlert
  /**
   * Stable key for the ONE alert this snapshot justifies, or undefined for a
   * silent update. The client/sender plays a sound at most once per key.
   */
  alertKey?: string
  /** Legacy v1/v2 fields — kept so older native builds keep working. */
  ordersToday: number
  statusLine: string
  pendingApprovals: number
  openTasks: number
}

// ---------------------------------------------------------------------------
// Clamps (spec §4 data rules)
// ---------------------------------------------------------------------------

/** Non-negative integer, or 0 for anything unusable. */
export function clampCount(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.floor(v))
}

/** Progress clamped to 0…1, or undefined when there is nothing real to show. */
export function clampProgress(p: unknown): number | undefined {
  if (p === null || p === undefined) return undefined
  const v = typeof p === 'number' ? p : Number(p)
  if (!Number.isFinite(v)) return undefined
  return Math.min(1, Math.max(0, v))
}

// ---------------------------------------------------------------------------
// Priority engine (spec §5)
// ---------------------------------------------------------------------------

export interface PulseConditions {
  hasUrgentAlert: boolean
  hasBlockingApproval: boolean
  runningOrderCount: number
  hasRunningJob: boolean
  /** Client-side only — the widget knows this via ActivityKit's isStale. */
  isStale?: boolean
  /** Client-side only — the server can never observe its own unreachability. */
  isOffline?: boolean
}

/**
 * The deterministic selector from spec §5. Order is load-bearing: a genuinely
 * urgent operational failure outranks an approval, which outranks ambient
 * order/job activity. `success` is NOT selected here — it is a transient the
 * client overlays after a confirmed action, then falls back to this result.
 */
export function selectPulseMode(c: PulseConditions): PulseMode {
  if (c.hasUrgentAlert) return 'urgent'
  if (c.hasBlockingApproval) return 'approval'
  if (clampCount(c.runningOrderCount) > 0) return 'orders'
  if (c.hasRunningJob) return 'working'
  if (c.isStale) return 'stale'
  if (c.isOffline) return 'offline'
  return 'overview'
}

// ---------------------------------------------------------------------------
// Alert dedupe keys (spec §11.5)
// ---------------------------------------------------------------------------

export function approvalEventKey(approvalId: string): string {
  return `approval:${approvalId}:created`
}

export function urgentEventKey(alertId: string): string {
  return `urgent:${alertId}:created`
}

/**
 * Reminder key for an approval still unresolved. `windowMs` buckets time so at
 * most one reminder fires per interval no matter how often we poll.
 */
export function reminderEventKey(approvalId: string, at: Date, windowMs = 60 * 60_000): string {
  const bucket = Math.floor(at.getTime() / windowMs)
  return `reminder:${approvalId}:${bucket}`
}

/**
 * The one event key this snapshot justifies alerting on, or undefined for a
 * silent update. Only urgent + approval alert (spec §11.1) — counts, progress
 * and success are always silent.
 */
export function alertKeyFor(input: {
  mode: PulseMode
  urgentAlert?: { id: string }
  approval?: { id: string }
}): string | undefined {
  if (input.mode === 'urgent' && input.urgentAlert) return urgentEventKey(input.urgentAlert.id)
  if (input.mode === 'approval' && input.approval) return approvalEventKey(input.approval.id)
  return undefined
}

// ---------------------------------------------------------------------------
// Bangla copy
// ---------------------------------------------------------------------------

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯']

/** 24 → "২৪". Owner-facing numbers are always Bangla (owner rule). */
export function toBanglaDigits(n: number | string): string {
  return String(n).replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)])
}

/** 48500 → "৳৪৮,৫০০" (whole taka only — never a float; see CLAUDE.md money rule). */
export function formatTakaBn(amount: number): string {
  const whole = Math.round(amount)
  const grouped = new Intl.NumberFormat('en-BD', { maximumFractionDigits: 0 }).format(Math.abs(whole))
  return `${whole < 0 ? '-' : ''}৳${toBanglaDigits(grouped)}`
}

/**
 * Headline + subtitle for a mode. Short, human, Bangla, never an enum name or a
 * technical error (spec §4). Callers may override the subtitle with something
 * more specific (e.g. the real order breakdown).
 */
export function copyForMode(
  mode: PulseMode,
  ctx: {
    pendingTaskCount: number
    approvalCount: number
    runningOrderCount: number
    urgentAlert?: PulseAlert
    approval?: PulseApproval
    success?: PulseSuccess
    /** Minutes since lastUpdatedAt — only used for the stale copy. */
    staleMinutes?: number
  },
): { headline: string; subtitle: string } {
  const attention = ctx.pendingTaskCount + ctx.approvalCount

  switch (mode) {
    case 'urgent':
      return {
        headline: ctx.urgentAlert?.title || 'জরুরি বিষয় ধরা পড়েছে',
        subtitle: ctx.urgentAlert?.detail || 'এখনই দেখা দরকার',
      }

    case 'approval':
      return {
        headline: 'আপনার অনুমোদনেই পরের ধাপ',
        subtitle: ctx.approval
          ? `${ctx.approval.title} — অপেক্ষায়`
          : `${toBanglaDigits(ctx.approvalCount)}টি অনুমোদন অপেক্ষায়`,
      }

    case 'orders':
      return {
        headline: `${toBanglaDigits(ctx.runningOrderCount)}টি অর্ডার চলছে`,
        subtitle: attention > 0 ? `${toBanglaDigits(attention)}টি বিষয়ে নজর দিন` : 'সব ঠিকঠাক এগোচ্ছে',
      }

    case 'working':
      return {
        headline: 'কাজ চলছে',
        subtitle: 'এজেন্ট এখন কাজ করছে',
      }

    case 'success':
      return {
        headline: ctx.success?.title || 'হয়ে গেছে',
        subtitle: ctx.success?.detail || 'কাজ আবার এগোচ্ছে',
      }

    case 'stale':
      return {
        headline: 'তথ্য পুরনো হতে পারে',
        subtitle:
          ctx.staleMinutes && ctx.staleMinutes > 0
            ? `সর্বশেষ আপডেট ${toBanglaDigits(ctx.staleMinutes)} মিনিট আগে`
            : 'সর্বশেষ পাওয়া তথ্য দেখাচ্ছে',
      }

    case 'offline':
      return {
        headline: 'সংযোগের অপেক্ষায়',
        subtitle: 'সর্বশেষ পাওয়া তথ্য দেখাচ্ছে',
      }

    case 'overview':
    default:
      return {
        headline: 'ব্যবসা স্বাভাবিক চলছে',
        subtitle:
          attention > 0 ? `${toBanglaDigits(attention)}টি বিষয়ে নজর দিন` : 'এই মুহূর্তে কিছু বাকি নেই',
      }
  }
}

/**
 * Rank + trim the notification feed to the three highest-priority rows
 * (spec §4: "Send only the three highest-priority items"). Ordering: severity
 * first, then newest — so an urgent stock mismatch always outranks a routine
 * pending task no matter when each appeared.
 */
export function topPulseItems(items: PulseItem[], limit = 3): PulseItem[] {
  const weight: Record<PulseSeverity, number> = { urgent: 0, attention: 1, normal: 2 }
  return [...items]
    .sort((a, b) => {
      const s = weight[a.severity] - weight[b.severity]
      if (s !== 0) return s
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    })
    .slice(0, Math.max(0, limit))
}

// ---------------------------------------------------------------------------
// Canonical native projection
// ---------------------------------------------------------------------------

/**
 * The EXACT JSON shape that PulseActivityAttributes.ContentState decodes on the
 * Swift side. Both transports use this one projection so they can never drift:
 *   • the local Capacitor bridge (passed as a `snapshotJson` string), and
 *   • the remote ActivityKit push (sent verbatim as aps.content-state).
 *
 * DATES ARE EPOCH SECONDS (numbers), never ISO strings and never Swift `Date`.
 * ActivityKit decodes a pushed content-state with its own JSONDecoder, whose
 * date strategy is not contractual — a `Date` field would decode against the
 * 2001 reference epoch on one path and 1970 on another. Plain `Double` seconds
 * are unambiguous on every path, so every date here is a `…Epoch` number.
 */
export interface PulseContentState {
  // Legacy v1/v2 keys — a build older than this one reads only these.
  ordersToday: number
  statusLine: string
  pendingApprovals: number
  openTasks: number

  // v3
  mode: PulseMode
  headline: string
  subtitle: string
  pendingTaskCount: number
  approvalCount: number
  runningOrderCount: number
  orderProgress?: number
  items: PulseContentItem[]
  updatedAtEpoch: number
  staleAfterEpoch: number

  approvalId?: string
  approvalTitle?: string
  approvalCounterparty?: string
  approvalAmountText?: string

  alertTitle?: string
  alertDetail?: string
  alertSeverity?: PulseSeverity

  successTitle?: string
  successDetail?: string
  successAtEpoch?: number
}

export interface PulseContentItem {
  id: string
  kind: PulseItemKind
  title: string
  subtitle: string
  valueText?: string
  progress?: number
  severity: PulseSeverity
  createdAtEpoch: number
  link?: string
}

function epoch(iso: string): number {
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? Math.floor(t / 1000) : Math.floor(Date.now() / 1000)
}

/** Drop undefined keys so the pushed payload stays as small as APNs demands. */
function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
  return o
}

/**
 * Project a snapshot into the native content state. `success` overrides the
 * mode with the transient success state (spec §6.6) — the native side shows it
 * briefly and then falls back to the snapshot's own mode, which is why the
 * underlying metrics are still carried here.
 */
export function toPulseContentState(
  snapshot: PulseSnapshot,
  opts?: { success?: PulseSuccess },
): PulseContentState {
  const success = opts?.success
  return compact({
    ordersToday: clampCount(snapshot.ordersToday),
    statusLine: snapshot.statusLine,
    pendingApprovals: clampCount(snapshot.approvalCount),
    openTasks: clampCount(snapshot.pendingTaskCount),

    mode: success ? 'success' : snapshot.mode,
    headline: success ? success.title : snapshot.headline,
    subtitle: success ? success.detail : snapshot.subtitle,
    pendingTaskCount: clampCount(snapshot.pendingTaskCount),
    approvalCount: clampCount(snapshot.approvalCount),
    runningOrderCount: clampCount(snapshot.runningOrderCount),
    orderProgress: clampProgress(snapshot.orderProgress),
    items: snapshot.items.map((i) =>
      compact({
        id: i.id,
        kind: i.kind,
        title: i.title,
        subtitle: i.subtitle,
        valueText: i.valueText,
        progress: clampProgress(i.progress),
        severity: i.severity,
        createdAtEpoch: epoch(i.createdAt),
        link: i.link,
      }),
    ),
    updatedAtEpoch: epoch(snapshot.lastUpdatedAt),
    staleAfterEpoch: epoch(snapshot.staleAfter),

    approvalId: snapshot.approval?.id,
    approvalTitle: snapshot.approval?.title,
    approvalCounterparty: snapshot.approval?.counterparty,
    approvalAmountText: snapshot.approval?.amountText,

    alertTitle: snapshot.urgentAlert?.title,
    alertDetail: snapshot.urgentAlert?.detail,
    alertSeverity: snapshot.urgentAlert?.severity,

    successTitle: success?.title,
    successDetail: success?.detail,
    successAtEpoch: success ? epoch(success.completedAt) : undefined,
  })
}
