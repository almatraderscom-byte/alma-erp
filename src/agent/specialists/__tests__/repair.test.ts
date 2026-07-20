import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { runWithRepair, REPAIR_REASON_CODES, MAX_REPAIR_ATTEMPTS } from '../repair';
import type { SpecialistAdapter, SpecialistBrief } from '../runtime';

const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const brief: SpecialistBrief = { identity, role: 'finance', task: 'invoice', input: {} };
const schema = z.object({ n: z.number().int() });

describe('runWithRepair (SPEC-179)', () => {
  it('returns COMPLETED immediately when the first output is valid', () => {
    const good: SpecialistAdapter = { role: 'finance', run: () => ({ role: 'finance', summary: 'ok', data: { n: 1 } }) };
    const o = runWithRepair(good, brief, schema);
    expect(o.result.status).toBe('COMPLETED');
    expect(o.attempts).toBe(1);
  });

  it('repairs on a later attempt, feeding violations back as constraints', () => {
    let call = 0;
    const flaky: SpecialistAdapter = {
      role: 'finance',
      run: (b) => {
        call += 1;
        // succeeds only once it sees repairViolations in constraints
        const hasFeedback = !!(b.constraints as { repairViolations?: string[] } | undefined)?.repairViolations;
        return { role: 'finance', summary: 'ok', data: hasFeedback ? { n: 5 } : { n: 1.5 } };
      },
    };
    const o = runWithRepair(flaky, brief, schema);
    expect(o.result.status).toBe('COMPLETED');
    expect(o.attempts).toBe(2);
    expect(call).toBe(2);
  });

  it('FAILED_FINAL (bounded) when output never conforms', () => {
    const bad: SpecialistAdapter = { role: 'finance', run: () => ({ role: 'finance', summary: 'ok', data: { n: 1.5 } }) };
    const o = runWithRepair(bad, brief, schema);
    expect(o.result.status).toBe('FAILED_FINAL');
    if (o.result.status === 'FAILED_FINAL') expect(o.result.reasonCodes).toContain(REPAIR_REASON_CODES.EXHAUSTED);
    expect(o.attempts).toBe(MAX_REPAIR_ATTEMPTS);
  });

  it('does not retry a non-schema failure (invalid brief) — terminal at once', () => {
    const good: SpecialistAdapter = { role: 'finance', run: () => ({ role: 'finance', summary: 'ok', data: { n: 1 } }) };
    const o = runWithRepair(good, { ...brief, task: '' }, schema);
    expect(o.result.status).toBe('FAILED_FINAL');
    expect(o.attempts).toBe(1);
  });

  it('clamps the attempt budget to the hard maximum', () => {
    const bad: SpecialistAdapter = { role: 'finance', run: () => ({ role: 'finance', summary: 'ok', data: { n: 1.5 } }) };
    const o = runWithRepair(bad, brief, schema, 999);
    expect(o.attempts).toBe(MAX_REPAIR_ATTEMPTS);
  });
});
