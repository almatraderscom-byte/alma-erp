/**
 * POST /api/assistant/plan-driver/action — owner one-click controls for an
 * in-flight autonomous plan, from the Live Desk (Phase C).
 *
 * Actions:
 *   - 'resume'      → lift an escalated/blocked plan back into the drive loop now
 *                     (clears the stall counter, fresh attempt budget).
 *   - 'add-budget'  → grant THIS plan one more cost-cap allowance, then resume.
 *                     Lifts ONLY this plan's cap (KV override), never the global one.
 *   - 'abandon'     → drop the plan from autodrive (terminal).
 *
 * Owner-only. The master kill-switch still applies — if AGENT_AUTODRIVE_ENABLED is
 * off the plan simply won't tick after resuming, which is the safe default.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { loadPlan, resumeAutodrive, abandonAutodrive } from '@/agent/lib/planner'
import {
  getAutodriveConfig,
  getPlanCapOverrideTaka,
  setPlanCapOverrideTaka,
} from '@/agent/lib/autodrive-config'

export const runtime = 'nodejs'

type Action = 'resume' | 'add-budget' | 'abandon'
const ACTIONS: ReadonlySet<Action> = new Set<Action>(['resume', 'add-budget', 'abandon'])

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  let body: { planId?: string; action?: string }
  try {
    body = (await req.json()) as { planId?: string; action?: string }
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 })
  }

  const planId = body.planId?.trim()
  const action = body.action?.trim() as Action | undefined
  if (!planId || !action || !ACTIONS.has(action)) {
    return NextResponse.json({ error: 'planId এবং বৈধ action দরকার' }, { status: 400 })
  }

  const plan = await loadPlan(planId)
  if (!plan) return NextResponse.json({ error: 'plan নেই' }, { status: 404 })

  if (action === 'abandon') {
    await abandonAutodrive(planId)
    return NextResponse.json({ ok: true, action, autodriveState: 'abandoned' })
  }

  if (action === 'add-budget') {
    // Grant one more full allowance on top of what this plan has already spent.
    const config = await getAutodriveConfig()
    const current = await getPlanCapOverrideTaka(planId)
    const grant = config.planCapTaka > 0 ? config.planCapTaka : 50
    const newCap = Math.max(current, plan.costTaka) + grant
    await setPlanCapOverrideTaka(planId, newCap)
  }

  // Both 'resume' and 'add-budget' put the plan back into the drive loop.
  await resumeAutodrive(planId)
  return NextResponse.json({ ok: true, action, autodriveState: 'driving' })
}
