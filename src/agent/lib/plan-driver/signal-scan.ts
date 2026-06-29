/**
 * Proactive signal scanner → Plan-Drive bridge (Feature A).
 *
 * The owner asked the agent to stop waiting for instructions and instead WATCH the
 * business — orders, stock, customers waiting, weak staff — and pull the genuinely
 * urgent issues into the autonomous Plan-Driver itself, so they get pursued until
 * resolved instead of sitting in a briefing nobody acts on.
 *
 * This is the proactive sibling of `promoteStuckTodosToPlanDrive`:
 *   - promote.ts pulls in the agent's OWN stuck todos (work it already started).
 *   - signal-scan.ts pulls in EXTERNAL business signals (work nobody asked for yet).
 *
 * Safety, by deliberate design — this never acts on its own beyond CREATING a plan:
 *   1. Master gate — only runs from the plan-driver tick, which is itself behind
 *      AGENT_AUTODRIVE_ENABLED (default OFF). Inert until the owner flips the env.
 *   2. Approval gating — the plan's side-effecting steps (placing a reorder, sending
 *      a staff/customer message) hit the executor's approval cards and PARK as
 *      'blocked' until the owner says yes. The scanner only proposes the pursuit.
 *   3. Cost caps — every created plan is driven under the same daily + per-plan
 *      whole-taka caps and stall escalation as any other autodrive plan.
 *   4. Dedup — one active plan per signal (KV-tracked), so a recurring issue can
 *      never spawn duplicate plans tick after tick.
 *   5. Throttle — the expensive ERP/Meta tour (buildOwnerBriefingData) runs at most
 *      once per SIGNAL_SCAN_INTERVAL_MIN even though the tick fires every few minutes.
 *
 * No DB migration: the dedup link + scan throttle live in agent_kv_settings, the
 * same KV pattern promote.ts and the per-plan cost overrides use.
 */
import { prisma } from '@/lib/prisma'
import {
  createPlan,
  enrollPlanForAutodrive,
  TERMINAL_AUTODRIVE_STATES,
  type AutodriveState,
} from '@/agent/lib/planner'
import { buildOwnerBriefingData, type OwnerBriefingData } from '@/agent/lib/owner-briefing-data'
import { notifyOwnerIfAway } from '@/agent/lib/notify-owner'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Minutes between full signal scans — bounds the expensive briefing tour. */
export const SIGNAL_SCAN_INTERVAL_MIN = 30
/** Hard ceiling on how many plans one scan may create — keeps spend bounded. */
export const MAX_SIGNALS_PER_SCAN = 5

const ACTIVE_PREFIX = 'signaldrive_active:'
const LAST_SCAN_KEY = 'signaldrive_last_scan'

function activeKey(businessId: string, signalKey: string): string {
  return `${ACTIVE_PREFIX}${businessId}:${signalKey}`
}

/**
 * A business signal worth pursuing autonomously. `signalKey` is STABLE across days
 * for the same kind of issue (keyed by product sku / issue type / staff name, never
 * by a count that changes daily) so dedup actually holds.
 */
export interface DrivableSignal {
  area: 'stock' | 'orders' | 'customers' | 'staff'
  urgency: 'high' | 'normal'
  /** Stable dedup identity, e.g. `stock:FM-133`, `orders:stuck_pending`. */
  signalKey: string
  /** Plan goal (Bangla, owner-facing). */
  goal: string
  /** Plain-language "what counts as done" for the completion gate. */
  doneCriteria: string
}

/**
 * Turn a daily briefing into the discrete signals the driver should pursue. PURE and
 * deterministic — no IO — so it is fully unit-testable. Conservative on purpose:
 *   - stock  : only HIGH-urgency reorder suggestions (urgent low stock).
 *   - orders : only HIGH-severity order issues (stuck/pile-up/mismatch etc.).
 *   - customers: only when the 24h reply window is actually closing (near-window).
 *   - staff  : repeat low performers (already 2+ low days when surfaced).
 * Capped to MAX_SIGNALS_PER_SCAN, highest-urgency first.
 */
export function selectDrivableSignals(briefing: OwnerBriefingData): DrivableSignal[] {
  const out: DrivableSignal[] = []

  // ── Stock: urgent reorders (the product sku is the stable identity) ──
  for (const r of briefing.reorderSuggestions ?? []) {
    if (r.urgency !== 'high') continue
    out.push({
      area: 'stock',
      urgency: 'high',
      signalKey: `stock:${r.id}`,
      goal: `${r.name} রিঅর্ডার করো (~${r.suggestedQty}টি) — ${r.reason}`,
      doneCriteria: `${r.name}-এর জন্য রিঅর্ডার সিদ্ধান্ত/অর্ডার সম্পন্ন হয়েছে (আনুমানিক ${r.suggestedQty}টি)।`,
    })
  }

  // ── Orders: high-severity issues (keyed by issue TYPE, not the daily count) ──
  for (const i of briefing.orderIssues ?? []) {
    if (i.severity !== 'high') continue
    out.push({
      area: 'orders',
      urgency: 'high',
      signalKey: `orders:${i.type}`,
      goal: `অর্ডার সমস্যা সমাধান করো — ${i.detail}`,
      doneCriteria: `"${i.detail}" সমস্যাটি সমাধান হয়েছে (pending clear / mismatch verify / কারণ চিহ্নিত)।`,
    })
  }

  // ── Customers: the 24h messaging window is closing ──
  const nearWindow = briefing.csWaiting?.nearWindowCount ?? 0
  if (nearWindow > 0) {
    out.push({
      area: 'customers',
      urgency: 'high',
      signalKey: 'customers:near_window',
      goal: `${nearWindow} জন কাস্টমারের 24h window প্রায় শেষ — reply নিশ্চিত করো`,
      doneCriteria: 'near-window কাস্টমারদের reply দেওয়া হয়েছে বা owner-কে এসকেলেট করা হয়েছে।',
    })
  }

  // ── Staff: repeat low performers (keyed by name) ──
  for (const p of briefing.staffYesterday?.lowPerformers ?? []) {
    out.push({
      area: 'staff',
      urgency: 'normal',
      signalKey: `staff:${p.name}`,
      goal: `${p.name}-এর সাথে ফলো-আপ — গত ${p.daysLow} দিন কাজ কম শেষ করছে (${p.pct}%)`,
      doneCriteria: `${p.name}-এর জন্য সহজ টাস্ক/ফলো-আপ ব্যবস্থা নেওয়া হয়েছে।`,
    })
  }

  // Highest-urgency first, then bound the batch.
  out.sort((a, b) => (a.urgency === b.urgency ? 0 : a.urgency === 'high' ? -1 : 1))
  return out.slice(0, MAX_SIGNALS_PER_SCAN)
}

/** Is the plan behind this id still being pursued (non-terminal autodrive state)? */
async function planStillActive(planId: string): Promise<boolean> {
  const row = await db.agentPlan.findUnique({
    where: { id: planId },
    select: { autodriveState: true },
  })
  if (!row) return false
  const state = (row.autodriveState ?? 'idle') as AutodriveState
  return !TERMINAL_AUTODRIVE_STATES.has(state)
}

/** Has the throttle window elapsed since the last full scan? */
async function throttleElapsed(now: Date): Promise<boolean> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: LAST_SCAN_KEY } })
  if (!row?.value) return true
  const last = Date.parse(row.value)
  if (!Number.isFinite(last)) return true
  return now.getTime() - last >= SIGNAL_SCAN_INTERVAL_MIN * 60_000
}

async function stampScan(now: Date): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: LAST_SCAN_KEY },
    update: { value: now.toISOString() },
    create: { key: LAST_SCAN_KEY, value: now.toISOString() },
  })
}

export interface SignalScanResult {
  scanned: number
  created: Array<{ planId: string; goal: string; signalKey: string }>
  /** True when the throttle window had not elapsed — nothing was scanned. */
  skipped?: boolean
  reason?: string
}

/**
 * Scan the business for urgent signals and pull each NEW one into the Plan-Driver.
 * Called once per tick (after the stuck-todo sweep); throttled internally so the
 * expensive briefing tour only runs ~SIGNAL_SCAN_INTERVAL_MIN apart. Idempotent
 * (KV dedup) and bounded (MAX_SIGNALS_PER_SCAN). Never throws.
 *
 * `force` (owner-triggered preview/scan from chat) bypasses the throttle but keeps
 * dedup, so a manual scan never duplicates an already-active pursuit.
 */
export async function scanSignalsToPlanDrive(
  opts: { businessId?: string; now?: Date; force?: boolean } = {},
): Promise<SignalScanResult> {
  const now = opts.now ?? new Date()
  const businessId = opts.businessId ?? 'ALMA_LIFESTYLE'

  if (!opts.force && !(await throttleElapsed(now))) {
    return { scanned: 0, created: [], skipped: true, reason: 'throttled' }
  }

  let briefing: OwnerBriefingData
  try {
    briefing = await buildOwnerBriefingData()
  } catch (err) {
    console.warn('[signal-scan] briefing build failed:', err instanceof Error ? err.message : err)
    return { scanned: 0, created: [], skipped: true, reason: 'briefing-failed' }
  }

  // Stamp the scan time up front so a slow/partial run still throttles the next tick.
  await stampScan(now).catch(() => {})

  const signals = selectDrivableSignals(briefing)
  const created: SignalScanResult['created'] = []

  for (const sig of signals) {
    try {
      const key = activeKey(businessId, sig.signalKey)
      const existing = await prisma.agentKvSetting.findUnique({ where: { key } })
      // Already pursuing this exact signal → skip (no duplicate plan).
      if (existing?.value && (await planStillActive(existing.value))) continue

      const plan = await createPlan({
        goal: sig.goal,
        steps: [{ action: sig.goal }],
        businessId,
      })
      await enrollPlanForAutodrive(plan.id, { doneCriteria: sig.doneCriteria })

      await prisma.agentKvSetting.upsert({
        where: { key },
        update: { value: plan.id },
        create: { key, value: plan.id },
      })

      created.push({ planId: plan.id, goal: sig.goal, signalKey: sig.signalKey })

      void notifyOwnerIfAway({
        tier: 2,
        title: 'Plan-Drive — নিজে থেকে কাজ ধরলাম',
        message: `"${sig.goal}" — জরুরি দেখে আমি নিজেই follow-up-এ নিলাম; শেষ না হওয়া পর্যন্ত চেষ্টা করব।`,
        category: 'task',
      }).catch(() => {})
    } catch (err) {
      console.warn(
        '[signal-scan] failed to enroll signal',
        sig.signalKey,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  return { scanned: signals.length, created }
}
