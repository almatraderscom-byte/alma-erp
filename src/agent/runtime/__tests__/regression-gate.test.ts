import { describe, it, expect } from 'vitest';
import { runRoutingHeadIsolationRegression } from '../regression-gate';
import { completed, type ComponentResult } from '@/agent/contracts';
import type { RouteDecision } from '@/agent/routing/measured-router';
import type { ModelTier } from '@/agent/models';

describe('SPEC-170 routing & head-isolation regression gate', () => {
  it('the real group passes every invariant check', () => {
    const report = runRoutingHeadIsolationRegression();
    expect(report.passed, JSON.stringify(report.checks.filter((c) => !c.ok))).toBe(true);
    expect(report.checks.length).toBe(8);
  });

  it('is deterministic', () => {
    expect(runRoutingHeadIsolationRegression()).toEqual(runRoutingHeadIsolationRegression());
  });

  // Prove the gate has TEETH: feed a broken component and confirm it is caught.
  it('CATCHES a router that leaks a frontier default', () => {
    const brokenRouter = (): ComponentResult<RouteDecision> =>
      completed<RouteDecision>({ taskClass: 't', tier: 'T4' as ModelTier, provider: 'anthropic', model: 'claude-opus-4-8', score: 999, basis: 'measured' });
    const report = runRoutingHeadIsolationRegression({ routeModel: brokenRouter });
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.name === 'router-refuses-frontier-default')?.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'router-default-routes-non-frontier')?.ok).toBe(false);
  });

  it('CATCHES a de-escalation that returns frontier', () => {
    const brokenDeEsc = (): ModelTier => 'T4';
    const report = runRoutingHeadIsolationRegression({ deEscalatedExecutionTier: brokenDeEsc });
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.name === 'de-escalation-never-frontier')?.ok).toBe(false);
  });
});
