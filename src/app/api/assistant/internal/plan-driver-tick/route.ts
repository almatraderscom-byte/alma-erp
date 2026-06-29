/**
 * POST /api/assistant/internal/plan-driver-tick
 *
 * Plan-Driver tick — the heart of the autonomous "pursue-until-completion" engine.
 * Called by the worker scheduler every couple of minutes. The heavy logic lives
 * here (TypeScript + Prisma + planner), the worker is only a thin trigger.
 *
 * PHASE B = LIVE. When the kill-switch is on, this endpoint actually advances each
 * drivable plan by ONE bounded step (Qwen head turn), runs the completion gate when
 * all steps are done, and escalates stalls/cost-caps to the owner. Caps are checked
 * before any paid work, so the driver can never overspend by more than one in-flight
 * step. With the kill-switch OFF it is fully inert (no DB scan, no spend).
 *
 * Safety gates, in order:
 *   1. requireAgentEnabled()           — global agent kill switch.
 *   2. internal token                  — worker-only caller.
 *   3. AGENT_AUTODRIVE_ENABLED (env)   — autodrive master switch, default OFF.
 *   4. daily cost cap                  — no driving once the day's spend hits the cap.
 */
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { getAutodriveConfig, getTodayAutodriveSpendTaka } from '@/agent/lib/autodrive-config'
import { loadDrivablePlans } from '@/agent/lib/planner'
import { drivePlan } from '@/agent/lib/plan-driver/driver'
import { promoteStuckTodosToPlanDrive } from '@/agent/lib/plan-driver/promote'
import { scanSignalsToPlanDrive } from '@/agent/lib/plan-driver/signal-scan'

export const runtime = 'nodejs'

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch (err) {
    console.warn('[plan-driver] token compare failed:', err instanceof Error ? err.message : err)
    return false
  }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const config = await getAutodriveConfig()

  // Master gate. When off, the driver is fully inert — no DB scan, no work.
  if (!config.enabled) {
    return Response.json({ mode: 'disabled', skipped: true, reason: 'AGENT_AUTODRIVE_ENABLED != true' })
  }

  const spentBeforeTaka = await getTodayAutodriveSpendTaka()
  const dailyCapReached = config.dailyCapTaka > 0 && spentBeforeTaka >= config.dailyCapTaka

  // Daily cap is a hard stop — don't even scan plans; nothing paid runs today.
  if (dailyCapReached) {
    console.log(`[plan-driver] daily cap reached (${spentBeforeTaka}/${config.dailyCapTaka} taka) — idle`)
    return Response.json({
      mode: 'live',
      phase: 'B',
      dailyCapReached: true,
      dailyCapTaka: config.dailyCapTaka,
      spentTodayTaka: spentBeforeTaka,
      driven: 0,
      report: [],
    })
  }

  // Bridge (option খ): before driving plans, sweep the daily todo list and pull any
  // genuinely-stuck agent-task into the Plan-Driver. Newly promoted plans are
  // enrolled with nextTickAt=now, so loadDrivablePlans below picks them up this tick.
  let promotion = { scanned: 0, promoted: [] as Array<{ todoId: string; planId: string; goal: string }> }
  try {
    promotion = await promoteStuckTodosToPlanDrive({ limit: config.batchSize })
  } catch (err) {
    console.warn('[plan-driver] stuck-todo sweep failed:', err instanceof Error ? err.message : err)
  }

  // Feature A: proactively scan the business (orders/stock/customers/staff) and pull
  // any NEW urgent signal into the driver. Throttled internally (≈30 min) so the
  // expensive ERP/Meta tour doesn't run every tick; deduped so a recurring issue
  // never spawns a second plan. Newly created plans enroll with nextTickAt=now, so
  // loadDrivablePlans below picks them up this same tick.
  let signalScan = { scanned: 0, created: [] as Array<{ planId: string; goal: string; signalKey: string }> }
  try {
    const res = await scanSignalsToPlanDrive({})
    signalScan = { scanned: res.scanned, created: res.created }
  } catch (err) {
    console.warn('[plan-driver] signal scan failed:', err instanceof Error ? err.message : err)
  }

  const plans = await loadDrivablePlans({ limit: config.batchSize })

  const report: Array<{ planId: string; goal: string; outcome: string; detail: string; costTaka: number }> = []
  let spentThisTick = 0

  for (const plan of plans) {
    // Re-check the daily cap as we spend within the tick — stop the moment we hit it.
    if (config.dailyCapTaka > 0 && spentBeforeTaka + spentThisTick >= config.dailyCapTaka) {
      console.log('[plan-driver] daily cap reached mid-tick — stopping')
      break
    }
    const result = await drivePlan(plan, config)
    spentThisTick += result.costTaka
    report.push({
      planId: result.planId,
      goal: result.goal,
      outcome: result.outcome,
      detail: result.detail,
      costTaka: result.costTaka,
    })
  }

  const summary = {
    mode: 'live',
    phase: 'B',
    autodriveEnabled: config.enabled,
    driverModel: config.driverModel,
    gateModel: config.gateModel,
    dailyCapTaka: config.dailyCapTaka,
    spentTodayTaka: spentBeforeTaka + spentThisTick,
    spentThisTickTaka: spentThisTick,
    dailyCapReached: false,
    promotedFromTodos: promotion.promoted.length,
    signalsScanned: signalScan.scanned,
    signalsCreated: signalScan.created.length,
    drivablePlans: plans.length,
    driven: report.length,
    report,
  }

  console.log(
    `[plan-driver] live tick — ${report.length}/${plans.length} plan(s) driven, ` +
      `spent ${spentThisTick} taka this tick (${summary.spentTodayTaka}/${config.dailyCapTaka} today)`,
  )

  return Response.json(summary)
}
