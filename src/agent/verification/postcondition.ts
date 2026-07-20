/**
 * Deterministic postcondition verifier (G19 / SPEC-181).
 *
 * The self-verification loop's backbone: after the agent does something, a
 * postcondition states what MUST now be true, and this module checks it with a
 * deterministic predicate — never an LLM (INV-01). "After publish, the response
 * has a postId"; "after refund, status == 'refunded'". A postcondition is a small
 * serializable check over the observed result; if any check fails the operation
 * is not considered done.
 *
 * Returns a typed ComponentResult (COMPLETED = verified, FAILED_FINAL = the
 * postcondition did not hold). Pure, deterministic.
 */
import { z } from 'zod';
import type { ComponentResult } from '@/agent/contracts';

export type CheckOp = 'eq' | 'ne' | 'exists' | 'gt' | 'gte' | 'lt' | 'lte' | 'nonempty';

export interface PostconditionCheck {
  /** Dotted path into the observed result. */
  path: string;
  op: CheckOp;
  value?: unknown;
}

export interface Postcondition {
  id: string;
  checks: PostconditionCheck[];
}

export const POSTCONDITION_REASON_CODES = {
  FAILED: 'VERIFY_POSTCONDITION_FAILED',
  MALFORMED: 'VERIFY_POSTCONDITION_MALFORMED',
} as const;

const checkSchema = z.object({
  path: z.string().min(1),
  op: z.enum(['eq', 'ne', 'exists', 'gt', 'gte', 'lt', 'lte', 'nonempty']),
  value: z.unknown().optional(),
});
const postconditionSchema = z.object({ id: z.string().min(1), checks: z.array(checkSchema).min(1) });

/** Resolve a dotted path against an object. */
export function resolvePath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Evaluate a single check against the observed result. */
export function evalCheck(observed: unknown, check: PostconditionCheck): boolean {
  const actual = resolvePath(observed, check.path);
  switch (check.op) {
    case 'exists': return actual !== undefined && actual !== null;
    case 'nonempty':
      if (typeof actual === 'string') return actual.length > 0;
      if (Array.isArray(actual)) return actual.length > 0;
      return actual !== undefined && actual !== null;
    case 'eq': return actual === check.value;
    case 'ne': return actual !== check.value;
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const a = asNum(actual), b = asNum(check.value);
      if (a === null || b === null) return false;
      return check.op === 'gt' ? a > b : check.op === 'gte' ? a >= b : check.op === 'lt' ? a < b : a <= b;
    }
  }
}

/**
 * Verify a postcondition against an observed result. ALL checks must hold.
 * Returns COMPLETED with the failed-check list empty, or FAILED_FINAL listing the
 * checks that failed (fail-closed: a malformed postcondition fails, never passes).
 */
export function verifyPostcondition(post: Postcondition, observed: unknown): ComponentResult<{ verified: true }> {
  if (!postconditionSchema.safeParse(post).success) {
    return { status: 'FAILED_FINAL', reasonCodes: [POSTCONDITION_REASON_CODES.MALFORMED], evidenceIds: [] };
  }
  const failed = post.checks.filter((c) => !evalCheck(observed, c)).map((c) => `${c.path} ${c.op}`);
  if (failed.length > 0) {
    return { status: 'FAILED_FINAL', reasonCodes: [POSTCONDITION_REASON_CODES.FAILED, ...failed], evidenceIds: [] };
  }
  return { status: 'COMPLETED', value: { verified: true }, evidenceIds: [], versions: { verify: 'SPEC-181' } };
}
