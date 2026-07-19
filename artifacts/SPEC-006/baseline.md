# SPEC-006 Baseline — Canonical error taxonomy
No single error taxonomy existed; failures were ad-hoc throws / booleans. This
spec maps every failure to a typed ComponentFailure + finite reason code +
retryability. Builds on component.ts. No provider/model/db calls, zero cost.
Additive: `src/agent/contracts/errors.ts` (+test), `docs/architecture/error-taxonomy.md`.
