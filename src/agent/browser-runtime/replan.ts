/**
 * Browser replan limits + stall detection (G15 / SPEC-148).
 *
 * A browser agent that keeps failing to act (target not present, page changed)
 * will REPLAN. Unbounded, that is a cost sink and a wedge risk — it can replan
 * forever or loop on the same non-progressing state. This module bounds both:
 *
 *   - replan budget: `requestReplan` increments a counter and hard-stops
 *     (fail-closed) once `maxReplans` is reached.
 *   - stall guard: `recordStep` fingerprints each step as `cursor:observationHash`;
 *     an unchanged fingerprint means no progress. Consecutive stalls beyond
 *     `maxStalls` hard-stop — the agent is looping, so it is stopped, not spun.
 *
 * Pure + deterministic (INV-01): caps + signatures injected, no clock/RNG/IO.
 * Returns a G01 `ComponentResult`; the two hard-stops are the fail-closed (INV-05)
 * defense against runaway browser loops.
 */
import { allowed, type ComponentFailure, type ComponentResult, type FailureStatus } from '@/agent/contracts';

export const REPLAN_REASON_CODES = {
  REPLAN_LIMIT: 'BR_REPLAN_LIMIT_REACHED',
  STALLED: 'BR_STALLED_NO_PROGRESS',
  MALFORMED: 'BR_REPLAN_MALFORMED',
} as const;
export type ReplanReasonCode = (typeof REPLAN_REASON_CODES)[keyof typeof REPLAN_REASON_CODES];

/** Immutable replan/stall accounting for one browser task. */
export interface ReplanState {
  readonly replans: number;
  readonly stalls: number;
  readonly lastSignature: string | null;
}

export function emptyReplanState(): ReplanState {
  return { replans: 0, stalls: 0, lastSignature: null };
}

export interface ReplanCaps {
  maxReplans: number;
  maxStalls: number;
}

function rfail(status: FailureStatus, reasonCodes: string[]): ComponentFailure {
  return { status, reasonCodes, evidenceIds: [] };
}

function capsValid(caps: ReplanCaps): boolean {
  return (
    Number.isInteger(caps.maxReplans) && caps.maxReplans >= 0 &&
    Number.isInteger(caps.maxStalls) && caps.maxStalls >= 0
  );
}

/**
 * Request a replan. ALLOWED (with the incremented count) while under budget;
 * once the budget is reached the next request hard-stops FAILED_FINAL /
 * REPLAN_LIMIT_REACHED — the agent must not keep replanning.
 */
export function requestReplan(
  state: ReplanState,
  caps: ReplanCaps,
): { result: ComponentResult<{ replans: number }>; state: ReplanState } {
  if (!capsValid(caps)) return { result: rfail('FAILED_FINAL', [REPLAN_REASON_CODES.MALFORMED]), state };
  if (state.replans >= caps.maxReplans) {
    return { result: rfail('FAILED_FINAL', [REPLAN_REASON_CODES.REPLAN_LIMIT]), state };
  }
  const next: ReplanState = { ...state, replans: state.replans + 1 };
  return { result: allowed({ replans: next.replans }, [], { browser: '1.0.0' }), state: next };
}

/**
 * Record a step fingerprint and detect stalls. When the fingerprint is identical
 * to the previous step (same cursor + same observation), no progress was made and
 * the stall counter advances; distinct fingerprints reset it. Exceeding
 * `maxStalls` consecutive stalls hard-stops FAILED_FINAL / STALLED (loop broken).
 */
export function recordStep(
  state: ReplanState,
  signature: string,
  caps: ReplanCaps,
): { result: ComponentResult<{ stalls: number }>; state: ReplanState } {
  if (!capsValid(caps) || typeof signature !== 'string' || signature.length === 0) {
    return { result: rfail('FAILED_FINAL', [REPLAN_REASON_CODES.MALFORMED]), state };
  }
  const stalled = state.lastSignature === signature;
  const stalls = stalled ? state.stalls + 1 : 0;
  const next: ReplanState = { ...state, stalls, lastSignature: signature };

  if (stalls > caps.maxStalls) {
    return { result: rfail('FAILED_FINAL', [REPLAN_REASON_CODES.STALLED]), state: next };
  }
  return { result: allowed({ stalls }, [], { browser: '1.0.0' }), state: next };
}

/** Build a deterministic step signature from cursor + a bounded observation hash. */
export function stepSignature(cursor: number, observationHash: string): string {
  return `${cursor}:${observationHash}`;
}
