import { describe, it, expect } from 'vitest';
import { recommendOptimizations, type WorkflowStats, type OptimizationThresholds } from '../optimization';

const t: OptimizationThresholds = { maxStepFailRate: 0.3, maxWorkflowCostNanoUsd: 500_000_000, maxStepLatencyMs: 10_000 };

describe('workflow optimization recommendations (SPEC-199)', () => {
  it('recommends hardening a flaky step', () => {
    const stats: WorkflowStats[] = [{ workflowId: 'w', runs: 10, avgCostNanoUsd: 1, steps: [{ stepId: 's', runs: 10, failures: 5, skipped: 0, avgLatencyMs: 100 }] }];
    const r = recommendOptimizations(stats, t);
    expect(r.some((x) => x.type === 'harden_flaky_step' && x.target === 's')).toBe(true);
  });
  it('recommends reducing cost on an expensive workflow', () => {
    const stats: WorkflowStats[] = [{ workflowId: 'w', runs: 10, avgCostNanoUsd: 900_000_000, steps: [] }];
    expect(recommendOptimizations(stats, t).some((x) => x.type === 'reduce_workflow_cost')).toBe(true);
  });
  it('recommends optimizing a slow step and removing a dead step', () => {
    const stats: WorkflowStats[] = [{ workflowId: 'w', runs: 10, avgCostNanoUsd: 1, steps: [
      { stepId: 'slow', runs: 10, failures: 0, skipped: 0, avgLatencyMs: 20_000 },
      { stepId: 'dead', runs: 10, failures: 0, skipped: 10, avgLatencyMs: 1 },
    ] }];
    const r = recommendOptimizations(stats, t);
    expect(r.some((x) => x.type === 'optimize_slow_step' && x.target === 'slow')).toBe(true);
    expect(r.some((x) => x.type === 'remove_dead_step' && x.target === 'dead')).toBe(true);
  });
  it('emits nothing for a healthy workflow', () => {
    const stats: WorkflowStats[] = [{ workflowId: 'w', runs: 10, avgCostNanoUsd: 1, steps: [{ stepId: 's', runs: 10, failures: 0, skipped: 0, avgLatencyMs: 100 }] }];
    expect(recommendOptimizations(stats, t)).toEqual([]);
  });
});
