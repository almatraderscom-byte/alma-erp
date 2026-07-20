import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { runSchemaConstrained, validateOutput, SCHEMA_OUTPUT_REASON_CODES } from '../schema-output';
import type { SpecialistAdapter, SpecialistBrief } from '../runtime';

const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const brief: SpecialistBrief = { identity, role: 'finance', task: 'make invoice', input: {} };
const schema = z.object({ invoiceNo: z.string().min(1), totalNano: z.number().int().nonnegative() });

const good: SpecialistAdapter = { role: 'finance', run: () => ({ role: 'finance', summary: 'ok', data: { invoiceNo: 'INV-1', totalNano: 5000 } }) };
const bad: SpecialistAdapter = { role: 'finance', run: () => ({ role: 'finance', summary: 'ok', data: { invoiceNo: '', totalNano: 1.5 } }) };

describe('validateOutput (SPEC-172)', () => {
  it('returns the typed value on valid data', () => {
    const v = validateOutput(schema, { invoiceNo: 'X', totalNano: 1 });
    expect(v.ok).toBe(true);
    expect(v.value).toEqual({ invoiceNo: 'X', totalNano: 1 });
  });
  it('returns issues on invalid data', () => {
    const v = validateOutput(schema, { invoiceNo: '', totalNano: -1 });
    expect(v.ok).toBe(false);
    expect(v.issues.length).toBeGreaterThan(0);
  });
});

describe('runSchemaConstrained (SPEC-172)', () => {
  it('COMPLETED with the validated typed value', () => {
    const r = runSchemaConstrained(good, brief, schema);
    expect(r.status).toBe('COMPLETED');
    if (r.status === 'COMPLETED') expect(r.value.value).toEqual({ invoiceNo: 'INV-1', totalNano: 5000 });
  });
  it('RETRYABLE with violations when output is off-schema (never passes it through)', () => {
    const r = runSchemaConstrained(bad, brief, schema);
    expect(r.status).toBe('RETRYABLE');
    if (r.status === 'RETRYABLE') expect(r.reasonCodes).toContain(SCHEMA_OUTPUT_REASON_CODES.SCHEMA_VIOLATION);
  });
  it('propagates a runtime failure (invalid brief) unchanged', () => {
    const r = runSchemaConstrained(good, { ...brief, task: '' }, schema);
    expect(r.status).toBe('FAILED_FINAL');
  });
});
