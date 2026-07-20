# SPEC-121 — Baseline (gateway request contract)
G13 base: `f0dbec02` (integration-wave: G01–G11 + G10). Owned zone: `src/agent/tool-gateway`.

There is no central tool gateway today — tool side-effects run via the monolith
executor with ad-hoc guards. G13 introduces the single fail-closed door. This spec
freezes the CONTRACT + composer; stages land in SPEC-122..129.

Prereq surfaces confirmed (imported later by stages):
```
$ grep -n "export function decidePolicy\|runIfAuthorized\|applyObligations" src/agent/policy/*.ts
$ grep -n "reserve(budget\|commit(reservationId\|InMemoryBudgetStore" src/agent/budgets/budget.ts
$ grep -n "validateToolArgs" src/agent/tools/selection/arg-validation.ts
$ grep -n "buildProvenancedView\|evidenceStore" src/agent/tools/results/*.ts
$ ls src/agent/autonomy  # MISSING — G12 in parallel; wired at SPEC-126 after rebase
```
Migration boundary: ComponentResult-typed request envelope + GatewayContext +
fail-closed stage type + short-circuit composer.
Files: contract.ts, gateway.ts, index.ts, tsconfig.json, tests.
