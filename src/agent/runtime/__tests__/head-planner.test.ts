import { describe, it, expect } from 'vitest';
import { runHeadPlanner, validateHeadPlan, type HeadPlannerFn, type PlanRequest, type PlanStep } from '../head-planner';
import { isSuccess, type ExecutionIdentity } from '@/agent/contracts';

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const req = (over: Partial<PlanRequest> = {}): PlanRequest => ({ identity, taskClass: 'complex', planningTier: 'T4', ...over });

// A deterministic fake "head" that plans de-escalated worker steps (no real model call).
const goodPlanner: HeadPlannerFn = () => [
  { stepId: 'a', taskClass: 'classify', executionTier: 'T1' },
  { stepId: 'b', taskClass: 'specialist', executionTier: 'T2' },
  { stepId: 'c', taskClass: 'reason', executionTier: 'T3' },
];

describe('SPEC-168 frontier head planner contract', () => {
  it('a frontier-planned plan whose steps all de-escalate is accepted', () => {
    const res = runHeadPlanner(req({ planningTier: 'T4' }), { planner: goodPlanner });
    expect(isSuccess(res)).toBe(true);
    if (isSuccess(res)) {
      expect(res.value.planningTier).toBe('T4');
      expect(res.value.steps.every((s) => s.executionTier !== 'T4')).toBe(true); // never frontier execution
    }
  });

  it('rejects a plan that schedules a frontier EXECUTION step', () => {
    const badPlanner: HeadPlannerFn = () => [{ stepId: 'x', taskClass: 't', executionTier: 'T4' }];
    const res = runHeadPlanner(req(), { planner: badPlanner });
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('EXEC_FRONTIER_FORBIDDEN');
  });

  it('rejects a step above the de-escalation ceiling', () => {
    // planned at T3 → ceiling T2; a T3 execution step is not de-escalated
    const planner: HeadPlannerFn = () => [{ stepId: 'x', taskClass: 't', executionTier: 'T3' }];
    const res = runHeadPlanner(req({ planningTier: 'T3' }), { planner });
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('EXEC_NOT_DEESCALATED');
  });

  it('rejects an empty plan and duplicate step ids', () => {
    expect(runHeadPlanner(req(), { planner: () => [] }).status).toBe('FAILED_FINAL');
    const dup: HeadPlannerFn = () => [
      { stepId: 'a', taskClass: 't', executionTier: 'T1' },
      { stepId: 'a', taskClass: 't', executionTier: 'T2' },
    ];
    const res = runHeadPlanner(req(), { planner: dup });
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('HEAD_PLAN_DUPLICATE_STEP');
  });

  it('missing identity → FAILED_FINAL (planner not even invoked)', () => {
    let invoked = false;
    const spy: HeadPlannerFn = () => { invoked = true; return goodPlanner(req()); };
    const res = runHeadPlanner(req({ identity: { ...identity, actorId: '' } }), { planner: spy });
    expect(res.status).toBe('FAILED_FINAL');
    expect(invoked).toBe(false);
  });

  it('validateHeadPlan is deterministic', () => {
    const steps: PlanStep[] = goodPlanner(req());
    expect(validateHeadPlan({ planningTier: 'T4', steps })).toEqual(validateHeadPlan({ planningTier: 'T4', steps }));
  });
});
