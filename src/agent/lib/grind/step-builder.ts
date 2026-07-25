/**
 * findings → plan steps, with NO model call.
 *
 * Asking a head model to author 246 fix steps is exactly the kind of thing that
 * silently drops 40 of them and then reports success. The step graph is
 * therefore DERIVED: the model names a source ("fix everything the audit found"),
 * and this module turns the measured findings into a deterministic graph:
 *
 *   per family:  diagnose  →  fix batch 1  →  verify 1
 *                          →  fix batch 2  →  verify 2   …
 *   every 3rd verify:      regression sweep
 *
 * Every fix step DEPENDS ON its family's diagnose step, so the dependency
 * machinery (fixed in S0) is what physically prevents fixing before diagnosing.
 * Step markers ride in `toolName` (`__grind_*`), which the executor reads to
 * pick the right directive posture — no new column, no new execution surface.
 */
import type { FindingRow } from '@/agent/lib/grind/finding-set'

export const GRIND_STEP_TOOL = {
  diagnose: '__grind_diagnose',
  fix: '__grind_fix',
  verify: '__grind_verify',
  regression: '__grind_regression',
} as const

/** Findings per fix step. Small enough to verify honestly, big enough to move. */
export const DEFAULT_BATCH_SIZE = 10
/** A regression sweep after every N verifies. */
export const REGRESSION_EVERY = 3

export interface BuiltStep {
  action: string
  toolName: string
  /** Logical keys ("step-1"); createPlan resolves them to DB ids. */
  dependsOn: string[]
  /** Findings this step operates on (persisted by the caller as batchKey). */
  fingerprints: string[]
  family?: string
  batchKey?: string
  maxAttempts?: number
}

export interface BuiltPlan {
  goal: string
  steps: BuiltStep[]
  familyCount: number
  batchCount: number
}

const sevRank = (s: string) => {
  const i = ['critical', 'high', 'medium', 'low'].indexOf(s)
  return i < 0 ? 9 : i
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Build the whole campaign graph. Pure — same findings in, same steps out, which
 * is what makes it testable and what stops a "creative" plan from appearing.
 */
export function buildCampaignSteps(input: {
  target: string
  findings: FindingRow[]
  batchSize?: number
  regressionEvery?: number
}): BuiltPlan {
  const batchSize = Math.max(1, input.batchSize ?? DEFAULT_BATCH_SIZE)
  const regressionEvery = Math.max(0, input.regressionEvery ?? REGRESSION_EVERY)

  // Group by family, worst severity first — Boss's site gets its critical
  // problems fixed before its cosmetic ones, whatever order the crawl found them.
  const byFamily = new Map<string, FindingRow[]>()
  for (const f of input.findings) {
    const list = byFamily.get(f.family)
    if (list) list.push(f)
    else byFamily.set(f.family, [f])
  }
  const families = [...byFamily.entries()]
    .map(([family, findings]) => ({
      family,
      findings: [...findings].sort((a, b) => sevRank(a.severity) - sevRank(b.severity)),
      worst: Math.min(...findings.map((f) => sevRank(f.severity))),
    }))
    .sort((a, b) => (a.worst !== b.worst ? a.worst - b.worst : b.findings.length - a.findings.length))

  const steps: BuiltStep[] = []
  const key = (i: number) => `step-${i + 1}`
  let verifiesSinceSweep = 0
  let batchCount = 0

  for (const { family, findings } of families) {
    const label = describeFamily(family, findings)

    const diagnoseIdx = steps.length
    steps.push({
      action:
        `[${label}] আসল কারণ বের করো — ${findings.length}টা জায়গায় এই সমস্যা। ` +
        `প্রতিটার জন্য record_root_cause দিয়ে কারণ + প্রমাণ (file:line বা URL) লিখে রাখো। ` +
        `এই ধাপে কিছু ঠিক করবে না।`,
      toolName: GRIND_STEP_TOOL.diagnose,
      dependsOn: [],
      fingerprints: findings.map((f) => f.fingerprint),
      family,
    })

    const batches = chunk(findings, batchSize)
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b]
      const batchKey = `${family}#${b + 1}`
      batchCount++

      const fixIdx = steps.length
      steps.push({
        action:
          `[${label}] ব্যাচ ${b + 1}/${batches.length} — ${batch.length}টা ঠিক করো ` +
          `(diagnose ধাপে লেখা কারণ ধরে)। কারণটা কোনোটাকে ব্যাখ্যা না করলে সেটাকে needs_rediagnosis করো।`,
        toolName: GRIND_STEP_TOOL.fix,
        // The dependency IS the root-cause discipline: a fix cannot be dispatched
        // before its family's diagnosis is done.
        dependsOn: [key(diagnoseIdx)],
        fingerprints: batch.map((f) => f.fingerprint),
        family,
        batchKey,
      })

      steps.push({
        action: `[${label}] ব্যাচ ${b + 1} আবার মেপে দেখো — সত্যিই ঠিক হয়েছে কিনা।`,
        toolName: GRIND_STEP_TOOL.verify,
        dependsOn: [key(fixIdx)],
        fingerprints: batch.map((f) => f.fingerprint),
        family,
        batchKey,
      })
      verifiesSinceSweep++

      if (regressionEvery > 0 && verifiesSinceSweep >= regressionEvery) {
        verifiesSinceSweep = 0
        steps.push({
          action:
            `আগের ফিক্সগুলো নতুন কোনো সমস্যা বানিয়েছে কিনা দেখো (regression sweep) — ` +
            `নতুন কিছু পেলে সেটাই এখন সবচেয়ে জরুরি।`,
          toolName: GRIND_STEP_TOOL.regression,
          dependsOn: [key(steps.length - 1)],
          fingerprints: [],
        })
      }
    }
  }

  // Final full re-measurement — the campaign can never end on scoped evidence
  // alone (see the I3 completion gate).
  if (steps.length > 0) {
    steps.push({
      action:
        `পুরো ${input.target} আবার মাপো (সম্পূর্ণ audit) — শেষ হিসাব এই মাপের উপর হবে, ` +
        `আগের ব্যাচ-ভিত্তিক যাচাইয়ের উপর নয়।`,
      toolName: GRIND_STEP_TOOL.regression,
      dependsOn: [`step-${steps.length}`],
      fingerprints: [],
    })
  }

  return {
    goal: `${input.target} — ${input.findings.length}টা সমস্যা ঠিক করা`,
    steps,
    familyCount: families.length,
    batchCount,
  }
}

/** Human label for a family — the issue's own words when we have them. */
export function describeFamily(family: string, findings: FindingRow[]): string {
  const detail = findings.find((f) => f.detail)?.detail
  if (!detail) return family
  // The crawler's details carry counts ("3টা ছবির মধ্যে 2টায় alt নেই"); the
  // family label wants the kind, not one instance's numbers.
  return detail.replace(/^\d+টা\s*/, '').slice(0, 60)
}
