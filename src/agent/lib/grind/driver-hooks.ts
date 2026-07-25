/**
 * Where the grind engine meets the Plan-Driver.
 *
 * INVARIANT I2 — no second execution surface. The engine adds exactly three
 * hooks around the existing loop, and every action still goes
 * runOwnerTurn → runRegisteredTool → guardToolCall:
 *
 *   beforeStep(step)   pre-flight: a fix may not be dispatched without a real
 *                      root cause (S3), and an unapproved family runs in
 *                      proposal mode (S6).
 *   afterStep(step)    a verify step re-measures deterministically (S4); a
 *                      regression step diffs against the baseline (S5); a batch
 *                      that did not actually get fixed queues new work.
 *   completion(plan)   arithmetic, not a prompt (S7 / I3).
 */
import {
  appendCorrectiveStep,
  loadPlan,
  markStepFailed,
  type PlanStep,
} from '@/agent/lib/planner'
import { prisma } from '@/lib/prisma'
import { getStepMeta, loadLatestSeoAudit, putStepMeta } from '@/agent/lib/grind/campaign'
import { checkStepDiagnosisGate } from '@/agent/lib/grind/diagnosis-gate'
import { verifyStep } from '@/agent/lib/grind/step-verifier'
import { guardRegressions } from '@/agent/lib/grind/regression-guard'
import { runGrindCompletionGate, type GrindCompletion } from '@/agent/lib/grind/completion'
import { getFamilyMode } from '@/agent/lib/grind/family-approval'
import { listFindings, loadFindingSet } from '@/agent/lib/grind/finding-set'
import { GRIND_STEP_TOOL } from '@/agent/lib/grind/step-builder'
import { agentStorageDownload } from '@/agent/lib/storage'
import type { AuditJson } from '@/agent/lib/seo-report'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Is this plan step part of a grind campaign at all? */
export function isGrindStep(step: Pick<PlanStep, 'toolName'>): boolean {
  return (step.toolName ?? '').startsWith('__grind_')
}

export interface PreflightVerdict {
  allow: boolean
  /** Extra directive text appended to the step turn (proposal mode, warnings). */
  directiveSuffix?: string
  reason?: string
}

/**
 * Pre-flight for one step. Deterministic and fail-safe: when the gate cannot
 * confirm a root cause, the fix does NOT run.
 */
export async function preflightGrindStep(planId: string, step: PlanStep): Promise<PreflightVerdict> {
  if (!isGrindStep(step)) return { allow: true }
  const meta = await getStepMeta(step.id)
  if (!meta) return { allow: true }

  if (meta.kind !== 'fix') return { allow: true }

  const gate = await checkStepDiagnosisGate(step.id)
  if (!gate.ready) {
    // Send the family's diagnosis back for another round — retrying the FIX with
    // the same missing cause would just fail the same way.
    await requeueDiagnose(planId, meta.family ?? null)
    await markStepFailed(step.id, `root-cause gate: ${gate.reason}`)
    return { allow: false, reason: gate.reason }
  }

  const set = await loadFindingSet(meta.setId)
  const family = meta.family ?? ''
  const mode = set && family ? await getFamilyMode(set.target, family) : 'proposal'
  if (mode === 'proposal') {
    return {
      allow: true,
      directiveSuffix:
        '\n\n[PROPOSAL MODE — এই ধরনের কাজ Boss এখনো অনুমোদন করেননি]\n' +
        '- কোনো কিছু পরিবর্তন কোরো না। শুধু দেখাও: এখন কী আছে → কী করতে চাও (হুবহু আগের/পরের লেখা)।\n' +
        '- শেষে ask_user card দিয়ে Boss-এর অনুমতি চাও; অনুমতি পেলে বাকিগুলো নিজে থেকেই করবে।',
    }
  }
  return { allow: true }
}

/** Put a family's diagnose step back to pending so the cause is found properly. */
async function requeueDiagnose(planId: string, family: string | null): Promise<void> {
  if (!family) return
  const plan = await loadPlan(planId)
  if (!plan) return
  for (const s of plan.steps) {
    if (s.toolName !== GRIND_STEP_TOOL.diagnose) continue
    const meta = await getStepMeta(s.id)
    if (meta?.family !== family) continue
    await db.agentPlanStep
      .update({ where: { id: s.id }, data: { status: 'pending', turnId: null, dispatchedAt: null } })
      .catch(() => {})
    return
  }
}

export interface PostStepResult {
  /** Owner-facing one-liner about what the deterministic check found. */
  detail: string
  /** True when the campaign was halted (three regressions). */
  halted?: boolean
  /** True when new corrective work was queued. */
  queuedMore?: boolean
}

/**
 * Runs AFTER a grind step's turn completes. This is where the model's claim is
 * checked against reality — the step's own text is never evidence.
 */
export async function afterGrindStep(planId: string, step: PlanStep): Promise<PostStepResult | null> {
  if (!isGrindStep(step)) return null
  const meta = await getStepMeta(step.id)
  if (!meta) return null

  if (meta.kind === 'verify') {
    const outcome = await verifyStep(step.id)
    if (outcome.stillPresent.length > 0) {
      // Not fixed. Queue ONE more attempt at exactly the leftovers, with its own
      // verify — the plan grows only by what the measurement says is left.
      await queueLeftoverWork(planId, meta.setId, meta.family ?? null, outcome.stillPresent)
      return { detail: outcome.detail, queuedMore: true }
    }
    return { detail: outcome.detail }
  }

  if (meta.kind === 'regression') {
    const report = await runRegressionSweep(meta.setId, meta.family ?? null, meta.fingerprints)
    return report ? { detail: report.detail, halted: report.halted } : null
  }

  return null
}

/** Compare the newest full audit against the campaign baseline. */
export async function runRegressionSweep(
  setId: string,
  suspectFamily: string | null,
  suspectFingerprints: string[],
) {
  const set = await loadFindingSet(setId)
  if (!set || set.source !== 'seo_audit' || !set.baselineRef) return null

  const latest = await loadLatestSeoAudit(set.target)
  if (!latest || latest.ref === set.baselineRef) {
    // Nothing newer than the baseline was measured — say so rather than
    // reporting a clean sweep we did not actually perform.
    return { introduced: 0, regressedBatch: [], familyRevoked: null, halted: false,
      detail: 'নতুন কোনো পূর্ণ মাপ পাওয়া যায়নি — regression যাচাই করা যায়নি।' }
  }

  let baseline: AuditJson
  try {
    baseline = JSON.parse((await agentStorageDownload(set.baselineRef)).toString('utf8')) as AuditJson
  } catch {
    return null
  }

  return guardRegressions({
    set,
    baseline,
    after: latest.audit as AuditJson,
    suspectFamily,
    suspectFingerprints,
  })
}

/**
 * Append a fix + verify pair for findings a verification proved are still there.
 * The corrective steps carry their own grind metadata, so they go through the
 * exact same gates as the original ones.
 */
async function queueLeftoverWork(
  planId: string,
  setId: string,
  family: string | null,
  leftoverIds: string[],
): Promise<void> {
  const rows = (await listFindings(setId)).filter((r) => leftoverIds.includes(r.id))
  if (rows.length === 0) return
  const fingerprints = rows.map((r) => r.fingerprint)
  const label = family ?? 'বাকি সমস্যা'

  await appendCorrectiveStep(
    planId,
    `[${label}] মেপে দেখা গেল ${rows.length}টা এখনো ঠিক হয়নি — আগের কারণটা ভুল ছিল ধরে নিয়ে আবার দেখো, তারপর ঠিক করো।`,
  )
  const plan = await loadPlan(planId)
  const appended = plan?.steps[plan.steps.length - 1]
  if (appended) {
    await putStepMeta(appended.id, { setId, kind: 'fix', family: family ?? undefined, fingerprints })
  }

  await appendCorrectiveStep(planId, `[${label}] ওই ${rows.length}টা আবার মেপে দেখো।`)
  const plan2 = await loadPlan(planId)
  const verifyStepRow = plan2?.steps[plan2.steps.length - 1]
  if (verifyStepRow) {
    await putStepMeta(verifyStepRow.id, { setId, kind: 'verify', family: family ?? undefined, fingerprints })
  }
}

/**
 * The completion verdict for a plan that belongs to a campaign. Returns null for
 * ordinary plans, which keep the existing (small, LLM) gate.
 */
export async function grindCompletionForPlan(planId: string): Promise<GrindCompletion | null> {
  const set = await db.agentFindingSet.findFirst({ where: { planId }, select: { id: true } })
  if (!set) return null
  return runGrindCompletionGate(set.id)
}
