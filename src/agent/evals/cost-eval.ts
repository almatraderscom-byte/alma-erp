/**
 * Cost-per-success evaluation (G19 / SPEC-187).
 *
 * The economic health metric: total spend (integer nano-USD) divided by the
 * number of tasks that actually SUCCEEDED. A cheap run that fails half its tasks
 * is not cheap. Deterministic (INV-01); money is integer nano-USD (no floats).
 */
import { GOLDEN_TASKS, type GoldenTask } from './golden';

export interface CostObservation { taskId: string; actualNanoUsd: number; succeeded: boolean }

export interface CostEvalResult {
  scored: number;
  successCount: number;
  totalNanoUsd: number;
  /** nano-USD per successful task; Infinity if nothing succeeded. */
  costPerSuccessNanoUsd: number;
  failures: string[];
}

export function evaluateCostPerSuccess(observations: CostObservation[], tasks: GoldenTask[] = GOLDEN_TASKS): CostEvalResult {
  const ids = new Set(tasks.map((t) => t.id));
  let scored = 0, successCount = 0, totalNanoUsd = 0;
  const failures: string[] = [];
  for (const o of observations) {
    if (!ids.has(o.taskId)) continue; // only score known golden tasks
    if (!Number.isInteger(o.actualNanoUsd) || o.actualNanoUsd < 0) continue; // ignore malformed cost
    scored += 1;
    totalNanoUsd += o.actualNanoUsd;
    if (o.succeeded) successCount += 1;
    else failures.push(o.taskId);
  }
  return {
    scored,
    successCount,
    totalNanoUsd,
    costPerSuccessNanoUsd: successCount === 0 ? Infinity : Math.round(totalNanoUsd / successCount),
    failures,
  };
}

/** Does cost-per-success regress beyond a ceiling? (Infinity always regresses.) */
export function costPerSuccessRegressed(result: CostEvalResult, ceilingNanoUsd: number): boolean {
  return !Number.isFinite(result.costPerSuccessNanoUsd) || result.costPerSuccessNanoUsd > ceilingNanoUsd;
}
