/**
 * Tool-selection evaluation (G19 / SPEC-186).
 *
 * Scores which tools the selector exposed for each golden task against the
 * expected set (SPEC-184): precision (did it avoid exposing irrelevant/dangerous
 * tools?) and recall (did it expose the needed tool?). Deterministic (INV-01).
 * Over-exposure of tools is a security concern; under-exposure is a capability gap.
 */
import { GOLDEN_TASKS, type GoldenTask } from './golden';

export interface ToolSelectionObservation { taskId: string; selectedTools: string[] }

export interface ToolSelectionEvalResult {
  scored: number;
  meanPrecision: number;
  meanRecall: number;
  perTask: Array<{ taskId: string; precision: number; recall: number; missing: string[]; extra: string[] }>;
}

function scoreOne(expected: string[], actual: string[]): { precision: number; recall: number; missing: string[]; extra: string[] } {
  const exp = new Set(expected), act = new Set(actual);
  const tp = [...act].filter((t) => exp.has(t)).length;
  const precision = act.size === 0 ? (exp.size === 0 ? 1 : 0) : tp / act.size;
  const recall = exp.size === 0 ? 1 : tp / exp.size;
  return { precision, recall, missing: [...exp].filter((t) => !act.has(t)), extra: [...act].filter((t) => !exp.has(t)) };
}

export function evaluateToolSelection(observations: ToolSelectionObservation[], tasks: GoldenTask[] = GOLDEN_TASKS): ToolSelectionEvalResult {
  const byId = new Map(observations.map((o) => [o.taskId, o.selectedTools]));
  const perTask: ToolSelectionEvalResult['perTask'] = [];
  for (const t of tasks) {
    const expected = t.expected.tools;
    if (!expected) continue;
    const actual = byId.get(t.id);
    if (actual === undefined) continue;
    perTask.push({ taskId: t.id, ...scoreOne(expected, actual) });
  }
  const n = perTask.length || 1;
  return {
    scored: perTask.length,
    meanPrecision: perTask.reduce((s, p) => s + p.precision, 0) / n,
    meanRecall: perTask.reduce((s, p) => s + p.recall, 0) / n,
    perTask,
  };
}
