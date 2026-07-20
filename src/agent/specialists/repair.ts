/**
 * Specialist retry and repair policy (G18 / SPEC-179).
 *
 * When a specialist returns off-schema output (SPEC-172 → RETRYABLE), we do not
 * give up and we do not loop forever: we re-ask a BOUNDED number of times, each
 * time feeding the exact schema violations back as constraints so the specialist
 * can correct itself. After the attempt budget is spent, it fails closed
 * (FAILED_FINAL) — a malformed result is never passed downstream.
 *
 * Deterministic given the adapter (INV-01). Bounded (no unbounded repair loop).
 */
import { z } from 'zod';
import type { ComponentResult } from '@/agent/contracts';
import { runSchemaConstrained, SCHEMA_OUTPUT_REASON_CODES } from './schema-output';
import type { SpecialistAdapter, SpecialistBrief } from './runtime';

export const REPAIR_REASON_CODES = {
  EXHAUSTED: 'SPECIALIST_REPAIR_EXHAUSTED',
} as const;

export const MAX_REPAIR_ATTEMPTS = 3;

export interface RepairOutcome<T> {
  result: ComponentResult<{ value: T; summary: string }>;
  attempts: number;
}

/**
 * Run a specialist with bounded schema-repair. Each retry appends the prior
 * violations to `constraints.repairViolations` so the adapter can fix them.
 * Returns the first COMPLETED result, or FAILED_FINAL once the budget is spent.
 */
export function runWithRepair<T>(
  adapter: SpecialistAdapter,
  brief: SpecialistBrief,
  schema: z.ZodType<T>,
  maxAttempts: number = MAX_REPAIR_ATTEMPTS,
): RepairOutcome<T> {
  const budget = Math.max(1, Math.min(maxAttempts, MAX_REPAIR_ATTEMPTS));
  let lastViolations: string[] = [];
  let attempts = 0;

  for (let i = 0; i < budget; i++) {
    attempts += 1;
    const attemptBrief: SpecialistBrief =
      lastViolations.length === 0
        ? brief
        : { ...brief, constraints: { ...(brief.constraints ?? {}), repairViolations: lastViolations } };

    const r = runSchemaConstrained(adapter, attemptBrief, schema);
    if (r.status === 'COMPLETED') return { result: r, attempts };
    if (r.status === 'RETRYABLE') {
      // Off-schema — capture violations and try again (unless budget spent).
      lastViolations = r.reasonCodes.filter((c) => c !== SCHEMA_OUTPUT_REASON_CODES.SCHEMA_VIOLATION);
      continue;
    }
    // Any other failure (invalid brief, adapter error) is terminal — do not retry.
    return { result: r, attempts };
  }

  return {
    result: { status: 'FAILED_FINAL', reasonCodes: [REPAIR_REASON_CODES.EXHAUSTED, ...lastViolations], evidenceIds: [] },
    attempts,
  };
}
