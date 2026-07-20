# SPEC-146 contract — Browser plan/perception/action separation

## Public contract
- Types: `PlanStep`, `BrowserPlan`, `ObservedElement`, `Observation`, `BrowserAction`; closed `STEP_INTENTS`.
- Fns (return G01 `ComponentResult`): `validatePlan`, `validateObservation`, `decideAction`; helper `resolveTarget`.
- Bounds: MAX_PLAN_STEPS=32, MAX_OBSERVED_ELEMENTS=64, MAX_INSTRUCTION_BYTES=4096.
- Reason codes: PLAN_MALFORMED, OBS_MALFORMED, TOO_MANY_STEPS, TOO_MANY_ELEMENTS, TARGET_NOT_IN_PERCEPTION, MISSING_TARGET_HINT, CURSOR_OUT_OF_RANGE, MALFORMED.

## Separation rule (the core invariant)
An ACTION is minted only in `decideAction`, from a plan step AND the current perception. click/type/read require the step's targetHint to resolve to a perception element; unresolved ⇒ DENIED/TARGET_NOT_IN_PERCEPTION. No action can target a non-present (hallucinated/injected) element.

## Invariants
INV-01 deterministic (model=Planner seam, browser=driver seam; core is pure). INV-02 identity on plan/observation/action. INV-05 fail-closed. INV-07 perception carries opaque refs + bounded elements, not raw DOM/secrets. No boolean success; no throw.
