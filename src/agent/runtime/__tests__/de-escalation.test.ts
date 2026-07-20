import { describe, it, expect } from 'vitest';
import { deEscalatedExecutionTier, assertDeEscalated } from '../de-escalation';
import { isSuccess } from '@/agent/contracts';
import type { ModelTier } from '@/agent/models';

describe('SPEC-167 de-escalation after planning', () => {
  it('execution ceiling is one tier below planning, never frontier, floored at T1', () => {
    expect(deEscalatedExecutionTier('T4')).toBe('T3'); // frontier planner → T3 execution
    expect(deEscalatedExecutionTier('T3')).toBe('T2');
    expect(deEscalatedExecutionTier('T2')).toBe('T1');
    expect(deEscalatedExecutionTier('T1')).toBe('T1'); // floor
  });

  it('a plan planned at frontier NEVER executes at frontier', () => {
    for (const planning of ['T2', 'T3', 'T4'] as ModelTier[]) {
      expect(deEscalatedExecutionTier(planning)).not.toBe('T4');
    }
  });

  it('rejects an execution step at frontier', () => {
    const res = assertDeEscalated('T4', 'T4');
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('EXEC_FRONTIER_FORBIDDEN');
  });

  it('rejects an execution tier above the de-escalation ceiling', () => {
    // planned at T3 → ceiling T2; asking to execute at T3 is not de-escalated
    const res = assertDeEscalated('T3', 'T3');
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('EXEC_NOT_DEESCALATED');
  });

  it('accepts execution at or below the ceiling', () => {
    expect(assertDeEscalated('T4', 'T3').status).toBe('COMPLETED');
    expect(assertDeEscalated('T4', 'T1').status).toBe('COMPLETED');
    expect(assertDeEscalated('T3', 'T2').status).toBe('COMPLETED');
    expect(assertDeEscalated('T2', 'T0').status).toBe('COMPLETED'); // deterministic execution fine
  });
});
