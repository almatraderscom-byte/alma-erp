# SPEC-110 Contract — Authorization bypass CI and runtime gate

## Runtime guard (`src/agent/policy/guard.ts`)
- `isAuthorized(decision)`, `requireAuthorized(decision) → {ok,value}|{ok,failure}`.
- `runIfAuthorized(decision, sideEffect)` / `runIfAuthorizedAsync(...)` — runs the side effect ONLY on ALLOW, passing `PolicyDecisionValue` (obligations, principalKey); on non-ALLOW returns the denial untouched and never invokes it (fail-closed, INV-05). No throw across the boundary (uses contract `isSuccess`).

## CI static gate (`bypass-gate.ts` + `check-authorization-bypass.mjs`)
- Pure: `scanFileForBypass(file, sourceText, imports[])`, `importsPolicyLayer`, `isAuthorizationAware`, `resolveToRepoPath`, `isInsidePolicyPackage`.
- Flags (outside `src/agent/policy/`): (1) `layer-evaluate` — deep-imports rbac/abac/relationship AND calls `.evaluate(`; (2) `hand-rolled-authz` — raw privileged-role literal (owner/admin/root/superuser) via `===`/`.roles.includes()`, ONLY in authz-aware files (import policy/identity). Line marker `policy-bypass-ok` = reviewed opt-out.
- Runner scoped to `src/agent` (ERP is out of scope + its 'owner' literals are data). Exit 1 on any violation.

## Package barrel (`index.ts`)
- `@/agent/policy` re-exports engine + layers + obligations + guard + gate. Outsiders depend on the barrel; decisions go through `decidePolicy`/`PolicyEngine.decide` + `runIfAuthorized`.

## Failure / cost / security
- Guard never throws; gate deterministic static analysis. Cost: 0 model calls (INV-01). Self-run: PASS clean.

## Rollback
`git revert --no-edit <SPEC-110 commit>` — restores exact pre-spec tree.
