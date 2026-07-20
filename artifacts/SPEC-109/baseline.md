# SPEC-109 Baseline — Policy obligations and redaction

## Current implementation and aliases
- SPEC-105 `PolicyDecisionValue` already carries `obligations: string[]` (union of permitting layers). No applier/redactor existed before this spec.
- `find src/agent/policy -name "*.ts" -not -path "*__tests__*"` → decision.ts(105), rbac.ts(106), abac.ts(107), relationship.ts(108).

## Callers and downstream dependencies
- None yet. Response Gate / Tool Gateway (later groups) will call `applyObligations` to produce the bounded model/caller view (INV-07). SPEC-110 adds the bypass gate.

## Direct provider/model/tool/database calls
- None. Pure string parsing + deterministic deep-clone/redact (INV-01). Verified by model-call-scan.

## Current tests / cost / latency evidence
- New: `src/agent/policy/__tests__/obligations.test.ts` (10 cases). Zero model calls / tokens.

## Tenant / permission / audit propagation
- Obligations originate from permit votes (already tenant-checked by the engine). `audit`/`deny_export` flags propagate to the caller for recording/export control.

## Likely bypass paths
- Malformed obligation silently ignored → data leak — mitigated: malformed obligations reported in `malformed[]`, never applied, never widen access.
- Input mutation leaking un-redacted refs — mitigated: deep-clone before transform; input never mutated.
- Unbounded obligations/path depth — mitigated: `MAX_OBLIGATIONS`, `MAX_PATH_DEPTH` caps.
- Partial-mask of a non-string secret — mitigated: non-string → full REDACTED.

## Proposed migration boundary
- `applyObligations` is the single redaction choke point invoked by response/tool boundaries; feature modes at integration wiring.

## Files expected to change
- `src/agent/policy/obligations.ts` (new), `src/agent/policy/__tests__/obligations.test.ts` (new), `artifacts/SPEC-109/**`.
