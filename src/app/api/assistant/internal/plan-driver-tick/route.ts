/**
 * POST /api/assistant/internal/plan-driver-tick
 *
 * Plan-Driver tick — the heart of the autonomous "pursue-until-completion" engine.
 * Called by the worker scheduler every couple of minutes. The heavy logic lives
 * here (TypeScript + Prisma + planner), the worker is only a thin trigger.
 *
 * PHASE A = SHADOW / DRY-RUN ONLY. This endpoint loads the plans the driver WOULD
 * act on, computes each plan's next ready step + a deterministic completion read,
 * and returns a report of what it WOULD do — but mutates NOTHING and spends NO
 * model money. Real step execution + the AI completion gate land in Phase B/C.
 *
 * Safety gates, in order:
 *   1. requireAgentEnabled()           — global agent kill switch.
 *   2. internal token                  — worker-only caller.
 *   3. AGENT_AUTODRIVE_ENABLED (env)   — autodrive master switch, default OFF.
 */
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { getAutodriveConfig, getTodayAutodriveSpendTaka } from '@/agent/lib/autodrive-config'
import { loadDrivablePlans, getReadySteps, selfCheck } from '@/agent/lib/planner'

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

  // Phase A: always shadow, even when the kill-switch is on. The executor is gated
  // behind a later phase; for now we only observe + report.
  const [plans, spentTodayTaka] = await Promise.all([
    loadDrivablePlans({ limit: config.batchSize }),
    getTodayAutodriveSpendTaka(),
  ])

  const dailyCapReached = config.dailyCapTaka > 0 && spentTodayTaka >= config.dailyCapTaka

  const report = plans.map((plan) => {
    const ready = getReadySteps(plan)
    const check = selfCheck(plan)
    const planCapReached = config.planCapTaka > 0 && plan.costTaka >= config.planCapTaka
    const attemptsExhausted = plan.attemptCount >= plan.maxAttempts

    // What WOULD the driver decide this tick? (computed, not executed)
    let wouldDo: string
    if (dailyCapReached) wouldDo = 'halt — daily cost cap reached'
    else if (planCapReached) wouldDo = 'halt — plan cost cap reached'
    else if (attemptsExhausted) wouldDo = 'escalate — max attempts exhausted'
    else if (check.allDone) wouldDo = 'run completion gate → likely mark DONE'
    else if (ready.length > 0) wouldDo = `execute next step: "${ready[0].action}"`
    else wouldDo = 'wait — no ready step (blocked on deps/approval)'

    return {
      planId: plan.id,
      goal: plan.goal,
      autodriveState: plan.autodriveState,
      attempts: `${plan.attemptCount}/${plan.maxAttempts}`,
      costTaka: plan.costTaka,
      progress: `${check.completedCount}/${check.totalCount}`,
      nextReadyStep: ready[0]?.action ?? null,
      wouldDo,
    }
  })

  const summary = {
    mode: 'shadow',
    phase: 'A',
    autodriveEnabled: config.enabled,
    gateModel: config.gateModel,
    dailyCapTaka: config.dailyCapTaka,
    spentTodayTaka,
    dailyCapReached,
    drivablePlans: plans.length,
    report,
  }

  console.log(
    `[plan-driver] shadow tick — ${plans.length} drivable plan(s), spent ${spentTodayTaka}/${config.dailyCapTaka} taka today` +
      (dailyCapReached ? ' (DAILY CAP REACHED)' : ''),
  )

  return Response.json(summary)
}
