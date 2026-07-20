/**
 * Head-model tool-loop prohibition (G17 / SPEC-169).
 *
 * The router-worker split: the head model PLANS (one shot, SPEC-168) and never
 * runs an agentic tool-execution loop — tool loops belong to the cheaper worker
 * tiers. Together with de-escalation (SPEC-167) this keeps the expensive
 * head/frontier model off the hot execution path, realising "no frontier head
 * model as a default".
 *
 * A "head invocation" is anything flagged `role: 'head'` OR running at the
 * frontier tier (T4) — a frontier invocation is head-class regardless of label,
 * so a frontier tier can NEVER run a tool loop. Deterministic, fail-closed: a head
 * invocation with any tool execution is a typed failure. No provider call (INV-01).
 */
import { completed, type ComponentFailure, type ComponentResult } from '@/agent/contracts';
import type { ModelTier } from '@/agent/models';

/** The head plans; it executes zero tools. Workers own tool loops. */
export const MAX_HEAD_TOOL_CALLS = 0;

export const HEAD_TOOL_LOOP_REASON_CODES = {
  TOOL_LOOP_FORBIDDEN: 'HEAD_TOOL_LOOP_FORBIDDEN',
  MALFORMED: 'HEAD_TOOL_LOOP_MALFORMED',
} as const;

export type ExecutionRole = 'head' | 'worker';

export interface ToolLoopClaim {
  role: ExecutionRole;
  tier: ModelTier;
  /** number of tool executions this invocation performed */
  toolCalls: number;
}

/** True when the invocation is head-class: an explicit head, or the frontier tier. */
export function isHeadInvocation(role: ExecutionRole, tier: ModelTier): boolean {
  return role === 'head' || tier === 'T4';
}

function fail(codes: string[]): ComponentFailure {
  return { status: 'FAILED_FINAL', reasonCodes: codes, evidenceIds: [] };
}

/** Fail-closed guard: a head-class invocation may not run a tool loop. */
export function assertNoHeadToolLoop(claim: ToolLoopClaim): ComponentResult<ToolLoopClaim> {
  if (!Number.isInteger(claim.toolCalls) || claim.toolCalls < 0) {
    return fail([HEAD_TOOL_LOOP_REASON_CODES.MALFORMED]);
  }
  if (isHeadInvocation(claim.role, claim.tier) && claim.toolCalls > MAX_HEAD_TOOL_CALLS) {
    return fail([HEAD_TOOL_LOOP_REASON_CODES.TOOL_LOOP_FORBIDDEN]);
  }
  return completed<ToolLoopClaim>(claim, [], { headToolLoop: '1.0.0' });
}
