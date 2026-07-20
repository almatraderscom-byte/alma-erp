# G11 — GROUP CERTIFICATION

Group: G11 — Identity Authorization and Policy Engine
Specs: SPEC-101..SPEC-110 · Individual PASS: 10/10 · Verdict: PASS

## Deliverables
| Spec | Deliverable |
| --- | --- |
| 101-104 | Principals — human / agent / workflow / credential; tenant-scoped; unified `Principal` union + `principalKey`/`principalRoles` |
| 105 | Unified policy decision API — deny-overrides + explicit-permit-required, fail-closed default DENY, tenant isolation pre-layer |
| 106 | RBAC layer — role→action grants (exact / `ns.*` / `*`), deny-overrides-allow |
| 107 | ABAC layer — serializable condition DSL over principal/resource/context, depth-bounded |
| 108 | Relationship (ReBAC) layer — `(subject,relation,object)` tuples, bounded one-hop, deny-veto |
| 109 | Obligations + redaction — redact/mask/audit/deny_export, bounded-view applier (INV-07) |
| 110 | Authorization bypass gate — runtime `runIfAuthorized` (fail-closed) + CI static gate + `@/agent/policy` barrel |

## Checkpoint
- Zone typecheck: PASS (tsc 0) · Zone tests: PASS (101)
- Fail-closed everywhere (INV-05); tenant isolation pre-layer (INV-02); deterministic, no LLM in the decision path (INV-01)
- Forbidden-import + authorization-bypass gates: PASS · Per-spec rollback drill: MATCH
- Scope: only `src/agent/policy`, `src/agent/identity`, `artifacts/` — 0 modifications/deletions; Hermes/schema/ERP untouched

## Verdict
**G11 PASS.** Folded into the integration wave (commit "integrate: G11 folded in").
Note: this summary file was regenerated at the final wave checkpoint; the group's
per-spec proof artifacts (SPEC-101..110) and code were folded in with the original
G11 integration.
