/**
 * Routing evaluation (G19 / SPEC-185).
 *
 * Scores actual model-tier routing decisions against the golden dataset (SPEC-184):
 * did each task route to the expected tier? Deterministic accuracy + a list of
 * misroutes (esp. a CRITICAL task under-routed to a cheaper tier — a safety
 * regression). Pure (INV-01).
 */
import { GOLDEN_TASKS, type GoldenTask } from './golden';

export interface RoutingObservation { taskId: string; tier: string }

export interface RoutingEvalResult {
  total: number;
  scored: number;
  correct: number;
  accuracy: number;
  misroutes: Array<{ taskId: string; expected: string; actual: string; critical: boolean }>;
}

/** Score routing observations against the golden expected tiers. */
export function evaluateRouting(observations: RoutingObservation[], tasks: GoldenTask[] = GOLDEN_TASKS): RoutingEvalResult {
  const byId = new Map(observations.map((o) => [o.taskId, o.tier]));
  let scored = 0;
  let correct = 0;
  const misroutes: RoutingEvalResult['misroutes'] = [];
  for (const t of tasks) {
    const expected = t.expected.tier;
    if (!expected) continue;
    const actual = byId.get(t.id);
    if (actual === undefined) continue; // no observation for this task
    scored += 1;
    if (actual === expected) correct += 1;
    else misroutes.push({ taskId: t.id, expected, actual, critical: expected === 'CRITICAL' });
  }
  return { total: tasks.length, scored, correct, accuracy: scored === 0 ? 0 : correct / scored, misroutes };
}

/** A CRITICAL task routed to a non-CRITICAL tier is a hard safety failure. */
export function hasCriticalUnderRouting(result: RoutingEvalResult): boolean {
  return result.misroutes.some((m) => m.critical);
}
