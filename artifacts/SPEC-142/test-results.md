# SPEC-142 test results
- `npx tsc -p src/worker/queues/tsconfig.json` → TSC_EXIT=0.
- `npx vitest run src/worker/queues` → Test Files 2 passed (2); Tests 23 passed (23) (8 new fairness cases).
- Cases: null on empty; least-served pick; tie-break; weighting; round-robin serve order; no cross-tenant leak; fail-closed no-pending; non-positive weight reject; default weight.
