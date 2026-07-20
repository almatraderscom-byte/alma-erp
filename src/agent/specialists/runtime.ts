/**
 * Specialist agent runtime contract (G18 / SPEC-171).
 *
 * A specialist is a STATELESS, task-scoped sub-agent: it receives a self-contained
 * brief and returns a summary/result — it holds no conversation, writes no memory,
 * performs no side effects of its own (the head owns all of that). This module
 * defines that brief/result contract and the deterministic runtime harness that
 * invokes a specialist through an ADAPTER SEAM (the actual model call lives behind
 * the seam; tests use a deterministic fake).
 *
 * Fail-closed (INV-05): a brief missing identity/tenant, or oversized, or an
 * adapter that errors, yields a typed FAILED_FINAL — never a thrown error, never
 * a boolean. Deterministic core (INV-01): no LLM/DB/network here — only the seam.
 */
import { z } from 'zod';
import {
  executionIdentitySchema,
  type ComponentResult,
  type ExecutionIdentity,
} from '@/agent/contracts';

export const MAX_BRIEF_BYTES = 128 * 1024;

export const SPECIALIST_REASON_CODES = {
  MISSING_IDENTITY: 'SPECIALIST_MISSING_IDENTITY',
  OVERSIZED_BRIEF: 'SPECIALIST_OVERSIZED_BRIEF',
  ADAPTER_ERROR: 'SPECIALIST_ADAPTER_ERROR',
  EMPTY_ROLE: 'SPECIALIST_EMPTY_ROLE',
  EMPTY_TASK: 'SPECIALIST_EMPTY_TASK',
} as const;

/** A self-contained instruction to a specialist. No hidden state. */
export interface SpecialistBrief {
  identity: ExecutionIdentity;
  /** Which specialist role runs this (marketing/cs/finance/…). */
  role: string;
  /** The discrete task, in words. */
  task: string;
  /** Structured input the specialist needs (bounded). */
  input: Record<string, unknown>;
  /** Hard constraints (word limits, tone, must-include, forbidden). */
  constraints?: Record<string, unknown>;
}

export interface SpecialistOutput {
  role: string;
  summary: string;
  data: Record<string, unknown>;
}

export type SpecialistResult = ComponentResult<SpecialistOutput>;

/** The seam a real specialist implementation fills (model call lives here). */
export interface SpecialistAdapter {
  readonly role: string;
  run(brief: SpecialistBrief): SpecialistOutput;
}

const briefSchema = z.object({
  identity: executionIdentitySchema,
  role: z.string().min(1),
  task: z.string().min(1),
  input: z.record(z.unknown()),
  constraints: z.record(z.unknown()).optional(),
});

function fail(reasonCodes: string[]): SpecialistResult {
  return { status: 'FAILED_FINAL', reasonCodes, evidenceIds: [] };
}

/** Validate a brief against the boundary rules; returns reason codes ([] = ok). */
export function validateBrief(brief: SpecialistBrief): string[] {
  const parsed = briefSchema.safeParse(brief);
  if (!parsed.success) {
    const codes = new Set<string>();
    for (const issue of parsed.error.issues) {
      const p = issue.path.join('.');
      if (p.startsWith('identity')) codes.add(SPECIALIST_REASON_CODES.MISSING_IDENTITY);
      else if (p === 'role') codes.add(SPECIALIST_REASON_CODES.EMPTY_ROLE);
      else if (p === 'task') codes.add(SPECIALIST_REASON_CODES.EMPTY_TASK);
      else codes.add(SPECIALIST_REASON_CODES.MISSING_IDENTITY);
    }
    return [...codes];
  }
  const size = Buffer.byteLength(JSON.stringify({ input: brief.input, constraints: brief.constraints ?? null }), 'utf8');
  if (size > MAX_BRIEF_BYTES) return [SPECIALIST_REASON_CODES.OVERSIZED_BRIEF];
  return [];
}

/**
 * Run a specialist through its adapter. Deterministic given the adapter. Never
 * throws: a validation failure or an adapter error becomes a typed FAILED_FINAL.
 * The adapter's role must match the brief's role.
 */
export function runSpecialist(adapter: SpecialistAdapter, brief: SpecialistBrief): SpecialistResult {
  const briefErrors = validateBrief(brief);
  if (briefErrors.length > 0) return fail(briefErrors);
  if (adapter.role !== brief.role) return fail([SPECIALIST_REASON_CODES.EMPTY_ROLE]);

  let out: SpecialistOutput;
  try {
    out = adapter.run(brief);
  } catch {
    return fail([SPECIALIST_REASON_CODES.ADAPTER_ERROR]);
  }
  return { status: 'COMPLETED', value: out, evidenceIds: [], versions: { specialist: 'SPEC-171' } };
}
