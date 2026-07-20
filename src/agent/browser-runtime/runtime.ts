/**
 * Browser runtime — plan/perception/action orchestration (G15 / SPEC-146).
 *
 * The deterministic core that enforces the three-phase separation. It validates a
 * model-produced plan, validates a perception, and DERIVES the next action from a
 * plan step + the current perception — refusing any action that targets an element
 * not present in the perception (the structural guard against hallucinated or
 * prompt-injected targets). Pure, no clock/RNG/IO (INV-01); every boundary returns
 * a G01 `ComponentResult`; fail-closed (INV-05).
 */
import { allowed, completed, type ComponentFailure, type ComponentResult, type FailureStatus } from '@/agent/contracts';
import {
  browserPlanSchema,
  observationSchema,
  BROWSER_REASON_CODES,
  MAX_PLAN_STEPS,
  MAX_OBSERVED_ELEMENTS,
  type BrowserAction,
  type BrowserPlan,
  type Observation,
  type PlanStep,
} from './contract';

function bfail(status: FailureStatus, reasonCodes: string[]): ComponentFailure {
  return { status, reasonCodes, evidenceIds: [] };
}

/** Validate a (model-produced) plan structurally. Never trust a raw plan. */
export function validatePlan(raw: unknown): ComponentResult<BrowserPlan> {
  const parsed = browserPlanSchema.safeParse(raw);
  if (!parsed.success) return bfail('FAILED_FINAL', [BROWSER_REASON_CODES.PLAN_MALFORMED]);
  if (parsed.data.steps.length > MAX_PLAN_STEPS) {
    return bfail('FAILED_FINAL', [BROWSER_REASON_CODES.TOO_MANY_STEPS]);
  }
  return completed(parsed.data as BrowserPlan, [], { browser: '1.0.0' });
}

/** Validate a perception structurally + size bound (compaction proper is SPEC-147). */
export function validateObservation(raw: unknown): ComponentResult<Observation> {
  const parsed = observationSchema.safeParse(raw);
  if (!parsed.success) return bfail('FAILED_FINAL', [BROWSER_REASON_CODES.OBS_MALFORMED]);
  if (parsed.data.elements.length > MAX_OBSERVED_ELEMENTS) {
    return bfail('FAILED_FINAL', [BROWSER_REASON_CODES.TOO_MANY_ELEMENTS]);
  }
  return completed(parsed.data as Observation, [], { browser: '1.0.0' });
}

/** Find the perception element whose label matches a plan step's targetHint. */
export function resolveTarget(observation: Observation, hint: string): string | null {
  const el = observation.elements.find((e) => e.label === hint);
  return el ? el.ref : null;
}

/**
 * Derive the next ACTION from the plan step at `cursor` and the current
 * perception. This is where plan and perception meet — the ONLY place an action
 * is minted, and only after the target is confirmed present.
 *
 *  - cursor at/after the last step ⇒ COMPLETED with a `stop` action (goal done).
 *  - navigate/read/stop that need no on-page target ⇒ allowed directly.
 *  - click/type ⇒ the step's targetHint MUST resolve to a perception element,
 *    else DENIED / TARGET_NOT_IN_PERCEPTION (fail-closed — never act blind).
 */
export function decideAction(
  plan: BrowserPlan,
  observation: Observation,
  cursor: number,
): ComponentResult<BrowserAction> {
  if (!Number.isInteger(cursor) || cursor < 0) {
    return bfail('FAILED_FINAL', [BROWSER_REASON_CODES.MALFORMED]);
  }
  // Plan exhausted ⇒ terminal stop (success), not an error.
  if (cursor >= plan.steps.length) {
    return completed({ type: 'stop', planStepIndex: cursor }, [], { browser: '1.0.0' });
  }
  const step: PlanStep = plan.steps[cursor];

  if (step.intent === 'stop') {
    return completed({ type: 'stop', planStepIndex: cursor }, [], { browser: '1.0.0' });
  }
  if (step.intent === 'navigate') {
    return allowed({ type: 'navigate', planStepIndex: cursor, url: step.url }, [], { browser: '1.0.0' });
  }

  // click / type / read all act on a page element ⇒ require a resolvable target.
  if (!step.targetHint) {
    return bfail('DENIED', [BROWSER_REASON_CODES.MISSING_TARGET_HINT]);
  }
  const ref = resolveTarget(observation, step.targetHint);
  if (ref === null) {
    return bfail('DENIED', [BROWSER_REASON_CODES.TARGET_NOT_FOUND]);
  }

  const action: BrowserAction = {
    type: step.intent,
    planStepIndex: cursor,
    targetRef: ref,
    ...(step.intent === 'type' ? { text: step.text } : {}),
  };
  return allowed(action, [], { browser: '1.0.0' });
}
