/**
 * Workflow optimization recommendations (G20 / SPEC-199).
 *
 * Closes the continuous-improvement loop: it reads aggregated workflow stats and
 * emits DETERMINISTIC, actionable recommendations — a flaky step to harden, a
 * costly workflow to cache or down-tier, a slow step to optimise, a step that is
 * always skipped to remove. Recommendations are advice for the owner, never
 * auto-applied (INV-01). Integer nano-USD.
 */
export interface StepStats {
  stepId: string;
  runs: number;
  failures: number;
  skipped: number;
  avgLatencyMs: number;
}

export interface WorkflowStats {
  workflowId: string;
  runs: number;
  avgCostNanoUsd: number;
  steps: StepStats[];
}

export interface OptimizationThresholds {
  maxStepFailRate: number;
  maxWorkflowCostNanoUsd: number;
  maxStepLatencyMs: number;
}

export type RecommendationType = 'harden_flaky_step' | 'reduce_workflow_cost' | 'optimize_slow_step' | 'remove_dead_step';

export interface Recommendation {
  type: RecommendationType;
  workflowId: string;
  target: string;
  rationale: string;
}

export function recommendOptimizations(stats: WorkflowStats[], t: OptimizationThresholds): Recommendation[] {
  const recs: Recommendation[] = [];
  for (const wf of stats) {
    if (wf.runs <= 0) continue;
    if (wf.avgCostNanoUsd > t.maxWorkflowCostNanoUsd) {
      recs.push({ type: 'reduce_workflow_cost', workflowId: wf.workflowId, target: wf.workflowId, rationale: `avg cost ${wf.avgCostNanoUsd} nano-USD exceeds ceiling` });
    }
    for (const s of wf.steps) {
      if (s.runs <= 0) continue;
      const failRate = s.failures / s.runs;
      if (failRate > t.maxStepFailRate) {
        recs.push({ type: 'harden_flaky_step', workflowId: wf.workflowId, target: s.stepId, rationale: `fail rate ${(failRate * 100).toFixed(0)}%` });
      }
      if (s.avgLatencyMs > t.maxStepLatencyMs) {
        recs.push({ type: 'optimize_slow_step', workflowId: wf.workflowId, target: s.stepId, rationale: `avg latency ${s.avgLatencyMs}ms` });
      }
      if (s.skipped === s.runs && s.runs > 0) {
        recs.push({ type: 'remove_dead_step', workflowId: wf.workflowId, target: s.stepId, rationale: 'always skipped' });
      }
    }
  }
  return recs;
}
