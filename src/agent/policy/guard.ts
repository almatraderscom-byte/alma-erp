/**
 * Authorization runtime guard (G11 / SPEC-110, runtime half).
 *
 * The single fail-closed enforcement point every side effect must pass through.
 * A tool call / write / external action may proceed ONLY when it holds a
 * `PolicyDecision` (from the SPEC-105 engine) whose status is `ALLOWED`. This
 * module makes "proceed" impossible without that proof: `runIfAuthorized` runs
 * the side effect thunk iff the decision allows, otherwise it returns the denial
 * unchanged and NEVER invokes the thunk (INV-05, fail-closed).
 *
 * There is no ambiguous boolean and no thrown control-flow across the boundary —
 * callers pattern-match on the returned `ComponentResult`. Deterministic (INV-01).
 */
import { isSuccess, type ComponentResult, type ComponentFailure } from '@/agent/contracts';
import type { PolicyDecision, PolicyDecisionValue } from './decision';

/** Narrow: was access allowed? */
export function isAuthorized(decision: PolicyDecision): boolean {
  return isSuccess(decision);
}

/**
 * Require an ALLOW. Returns the decision value on success or the exact
 * ComponentFailure on denial — never throws, never fabricates an allow.
 */
export function requireAuthorized(
  decision: PolicyDecision,
): { ok: true; value: PolicyDecisionValue } | { ok: false; failure: ComponentFailure } {
  if (isSuccess(decision)) return { ok: true, value: decision.value };
  return { ok: false, failure: decision };
}

/**
 * Run `sideEffect` ONLY if the decision allows; otherwise short-circuit to the
 * denial without touching the side effect. The side effect receives the decision
 * value (obligations, principalKey) so it can honour obligations (SPEC-109).
 *
 * This is the choke point later side-effect code (Tool Gateway, writers) calls:
 * there is no code path that reaches the thunk on a non-ALLOW decision.
 */
export function runIfAuthorized<T>(
  decision: PolicyDecision,
  sideEffect: (allow: PolicyDecisionValue) => ComponentResult<T>,
): ComponentResult<T> {
  if (!isSuccess(decision)) return decision; // fail-closed: denial passes through untouched
  return sideEffect(decision.value);
}

/** Async variant for I/O-bound side effects. Same fail-closed contract. */
export async function runIfAuthorizedAsync<T>(
  decision: PolicyDecision,
  sideEffect: (allow: PolicyDecisionValue) => Promise<ComponentResult<T>>,
): Promise<ComponentResult<T>> {
  if (!isSuccess(decision)) return decision;
  return sideEffect(decision.value);
}
