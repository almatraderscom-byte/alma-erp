/**
 * CS10 — deterministic engine comparison from golden-eval attempts.
 *
 * Owner's trust rule: no LLM rewrites routing policy. The ranking below is a
 * FIXED formula over measured numbers (pass rate, core-axis quality, cost,
 * latency) plus the owner's own deterministic ভালো/বাদ tallies. The output is
 * a recommendation REPORT — nothing here changes the Auto default; that stays
 * an explicit owner decision (canary controls land in CS12).
 */
import {
  GOLDEN_ENGINES,
  summarizeEngine,
  type EngineReport,
  type EvalAttempt,
  type GoldenEngineId,
} from './eval-types'

export type EngineFeedbackTally = { good: number; bad: number }

export type EngineComparison = {
  reports: EngineReport[]
  /** deterministic composite score per engine (higher = better) */
  rankings: Array<{ engine: GoldenEngineId; score: number; reasonBn: string }>
  /** the engine the numbers support — a recommendation, never auto-applied */
  recommended: GoldenEngineId | null
  verdictBn: string
}

export const ENGINE_LABELS_BN: Record<GoldenEngineId, string> = {
  fashn: 'FASHN Pro (direct)',
  fal_fashn_v16: 'Fal FASHN v1.6',
  fal_idm_vton: 'IDM-VTON (পরীক্ষামূলক)',
}

/**
 * Fixed weights: quality dominates, cost breaks ties, latency matters least.
 *  score = passRate(0..100)×0.5 + avgCore.overall(0..5)×8 + ownerNet×4
 *          − costPerCase×40 − p95Latency(min)×2 − errorRate×0.5
 */
export function scoreEngine(report: EngineReport, feedback?: EngineFeedbackTally): number {
  const ownerNet = feedback ? Math.max(-5, Math.min(5, feedback.good - feedback.bad)) : 0
  const costPerCase = report.cases ? report.totalCostUsd / report.cases : 0
  const errorRate = report.cases ? (report.errors / report.cases) * 100 : 0
  const score =
    report.passRate * 0.5
    + report.avgCore.overall * 8
    + ownerNet * 4
    - costPerCase * 40
    - (report.p95LatencyMs / 60_000) * 2
    - errorRate * 0.5
  return Math.round(score * 100) / 100
}

export function compareEngines(
  attempts: EvalAttempt[],
  feedback: Partial<Record<GoldenEngineId, EngineFeedbackTally>> = {},
): EngineComparison {
  const reports = GOLDEN_ENGINES.map((e) => summarizeEngine(e, attempts)).filter((r) => r.cases > 0)
  const rankings = reports
    .map((r) => ({
      engine: r.engine,
      score: scoreEngine(r, feedback[r.engine]),
      reasonBn: `${ENGINE_LABELS_BN[r.engine]}: পাস ${r.passRate}% · গড় মান ${r.avgCore.overall}/৫ · খরচ $${r.totalCostUsd} · p95 ${Math.round(r.p95LatencyMs / 1000)}s${r.errors ? ` · ${r.errors} error` : ''}`,
    }))
    .sort((a, b) => b.score - a.score)

  // Recommend only with a real margin AND a usable pass rate — otherwise the
  // honest answer is "no change".
  let recommended: GoldenEngineId | null = null
  if (rankings.length >= 2) {
    const [top, second] = rankings
    const topReport = reports.find((r) => r.engine === top.engine)!
    if (top.score - second.score >= 5 && topReport.passRate >= 60) recommended = top.engine
  } else if (rankings.length === 1) {
    recommended = rankings[0].engine
  }

  const verdictBn = recommended
    ? `সংখ্যা বলছে ${ENGINE_LABELS_BN[recommended]} এগিয়ে — তবে Auto ডিফল্ট বদলানো আপনার সিদ্ধান্ত (CS12-এ canary দিয়ে হবে)।`
    : 'কোনো ইঞ্জিন স্পষ্টভাবে এগিয়ে নেই — ডিফল্ট বদলানোর মতো প্রমাণ এখনো হয়নি।'

  return { reports, rankings, recommended, verdictBn }
}
