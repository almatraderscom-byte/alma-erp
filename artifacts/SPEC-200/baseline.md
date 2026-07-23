# SPEC-200 baseline — Production readiness and final architecture certification

Base commit: `8fe4410c76f6601efdf86fee10fb6fbf16409e9e` (origin/main).

## Discovery commands

- `ls src/agent/release` → `auto-rollback.ts, bake-off.ts, canary.ts, shadow.ts` (+ `__tests__`). No certification module exists.
- `ls src/agent/observability` → `dashboard-cost-quality.ts, dashboard-escalation-cache.ts, optimization.ts, slo.ts, trace.ts`. No certification consumer.
- `ls src/app/agent-ops` → **absent**; zone unused so far (left unused — no UI needed for a CI-consumed certification core).
- `grep -rn "certif" src/agent --include=*.ts -l` → no hits outside comments. No prior implementation or alias.
- `ls artifacts | grep SPEC- | wc -l` → 199 proof dirs (SPEC-001..SPEC-199); SPEC-200 missing — the freeze gate could not certify.
- `node scripts/architecture/check-proof.mjs --require-pass` → before this session: FAIL (SPEC-141..150 `verdict=NONE` — final-verdict format drift); fixed to `**Verdict: PASS**` and re-verified against their executable tests (`npx vitest run src/worker/queues src/agent/browser-runtime` → 106/106 PASS).
- `node scripts/architecture/freeze-gate.mjs` → after those repairs: `FREEZE BASELINE: PASS` (contracts typecheck+tests, forbidden-imports, ownership, adr-lint, proof-complete).

## Callers and downstream dependencies

- The freeze gate (`scripts/architecture/freeze-gate.mjs`) is the only certification-adjacent executable; it aggregates six gate steps but produces no typed, machine-readable certification artifact and does not verify spec-count completeness (a deleted proof dir would go unnoticed).
- CI (`.github/workflows/agent-gate.yml`) runs typecheck + `npm run test:agent` only — the freeze gate is NOT release-blocking today.

## Direct provider/model/tool/database calls

- None planned and none present in the owned zones; the certification core must stay pure/deterministic (INV-01) — evidence is passed in, never fetched.

## Tenant, permission and audit propagation

- All release/observability modules are identity-free pure cores; SPEC-200's boundary adds a `ComponentRequest<T>` envelope (ExecutionIdentity, contract version) with fail-closed identity validation, matching `@/agent/contracts` (SPEC-001).

## Likely bypass paths

1. Hand-editing a `final-verdict.md` to PASS without tests — mitigated: the runner recomputes gate results from executable commands; the core cross-checks spec-count completeness and gate coverage.
2. Deleting a failing spec dir — mitigated: `expectedSpecCount` (200) enforced; missing ids fail closed.
3. Claiming certification while a required gate step is absent — mitigated: closed set of REQUIRED gate steps must ALL be present and PASS.

## Proposed migration boundary

- New pure module `src/agent/release/certification.ts` (typed contract + deterministic verdict) with tests.
- New runner `scripts/architecture/certify-architecture.mjs` that executes the real gates, feeds their machine-readable outputs into the same rules, and writes `artifacts/SPEC-200/certification.json`.
- Freeze gate extended to require SPEC-200 evidence via the standard proof mechanism (no gate rewrite needed — `check-proof.mjs` picks up the new dir automatically).

## Files expected to change

- `src/agent/release/certification.ts` (new)
- `src/agent/release/__tests__/certification.test.ts` (new)
- `src/agent/release/index.ts` (new barrel or direct import — match existing pattern)
- `scripts/architecture/certify-architecture.mjs` (new)
- `artifacts/SPEC-200/*` (proof files)
