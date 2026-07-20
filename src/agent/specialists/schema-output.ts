/**
 * Schema-constrained specialist output (G18 / SPEC-172).
 *
 * A specialist's output is only useful if it is SHAPED — a caption with the right
 * fields, an invoice with numbers where numbers belong. This module runs a
 * specialist (SPEC-171) and validates its `data` against a caller-supplied zod
 * schema. Valid output returns COMPLETED with the typed value; off-schema output
 * returns RETRYABLE (so the repair loop, SPEC-179, can re-ask with the violations)
 * — it is NEVER passed through unchecked (INV-05, INV-07: the head only ever sees
 * conforming, bounded data).
 *
 * Deterministic given the adapter (INV-01).
 */
import { z } from 'zod';
import { isSuccess, type ComponentResult } from '@/agent/contracts';
import { runSpecialist, type SpecialistAdapter, type SpecialistBrief } from './runtime';

export const SCHEMA_OUTPUT_REASON_CODES = {
  SCHEMA_VIOLATION: 'SPECIALIST_SCHEMA_VIOLATION',
} as const;

export interface SchemaValidation<T> {
  ok: boolean;
  value?: T;
  issues: string[];
}

/** Validate arbitrary data against a schema, returning typed value or issues. */
export function validateOutput<T>(schema: z.ZodType<T>, data: unknown): SchemaValidation<T> {
  const parsed = schema.safeParse(data);
  if (parsed.success) return { ok: true, value: parsed.data, issues: [] };
  return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
}

/**
 * Run a specialist and constrain its output to `schema`. Returns COMPLETED with
 * the validated, typed value; propagates the runtime failure if the specialist
 * itself failed; or RETRYABLE with the schema violations if the output is off
 * schema (the repair loop consumes the reason codes).
 */
export function runSchemaConstrained<T>(
  adapter: SpecialistAdapter,
  brief: SpecialistBrief,
  schema: z.ZodType<T>,
): ComponentResult<{ value: T; summary: string }> {
  const r = runSpecialist(adapter, brief);
  if (!isSuccess(r)) return r; // validation/adapter failure already typed

  const v = validateOutput(schema, r.value.data);
  if (!v.ok) {
    return {
      status: 'RETRYABLE',
      reasonCodes: [SCHEMA_OUTPUT_REASON_CODES.SCHEMA_VIOLATION, ...v.issues],
      evidenceIds: [],
    };
  }
  return {
    status: 'COMPLETED',
    value: { value: v.value as T, summary: r.value.summary },
    evidenceIds: [],
    versions: { specialistSchema: 'SPEC-172' },
  };
}
