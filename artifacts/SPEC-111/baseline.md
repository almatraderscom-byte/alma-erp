# SPEC-111 Baseline — Autonomy decision states

## Current implementation and aliases
- New zone. Discovery: `find src/agent/autonomy src/agent/approvals -name "*.ts"` → empty before this spec.
- Builds on G11 `PolicyDecision` (`@/agent/policy`) and G01 `ComponentResult`/`isSuccess`.

## Callers and downstream dependencies
- None yet. SPEC-113..116 register concrete `ApprovalRule`s (money/publishing/HR/export); SPEC-112 the fail-closed approval contract; SPEC-117 separation-of-duties; SPEC-120 adversarial gate. The Tool Gateway (G13) will consult autonomy before any side effect.

## Direct provider/model/tool/database calls
- None. Pure reducer over policy decision + rule votes (INV-01). Verified by model-call-scan.

## Current tests / cost / latency evidence
- New: `src/agent/autonomy/__tests__/states.test.ts` (10 cases). Zero model calls / tokens.

## Tenant / permission / audit propagation
- Autonomy sits ON TOP of the G11 policy decision (which already enforced tenant isolation). A non-ALLOW policy decision short-circuits to DENIED before any rule runs.

## Likely bypass paths
- Acting autonomously on an unclassified action — closed: unclassified/all-abstain ⇒ NEEDS_APPROVAL (ask, don't act).
- A routine rule overriding a real risk flag — closed: require_approval overrides autonomous_ok.
- Malformed input silently acting — closed: malformed ⇒ NEEDS_APPROVAL (safe side).
- Autonomy overriding a policy deny — closed: policy non-ALLOW ⇒ DENIED.

## Proposed migration boundary
- `AutonomyEngine`/`decideAutonomy` is the single autonomy choke point the gateway consults; feature modes at integration wiring.

## Files expected to change
- `src/agent/autonomy/states.ts` (new), `src/agent/autonomy/tsconfig.json` (new), `__tests__/states.test.ts` (new), `artifacts/SPEC-111/**`.
