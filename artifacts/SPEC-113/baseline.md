# SPEC-113 Baseline — Financial action approval rules

## Current implementation and aliases
- First concrete `ApprovalRule` (interface from SPEC-111). Prior G12 files: autonomy/states.ts(111), approvals/contract.ts(112).
- Money model: integer nano-USD, consistent with G03/G04 (no floats, no BDT).

## Callers and downstream dependencies
- Registered into the SPEC-111 `AutonomyEngine`. SPEC-114..116 add publishing/HR/export rules alongside; SPEC-120 adversarial gate exercises them together.

## Direct provider/model/tool/database calls
- None. Pure classifier over the action descriptor (INV-01). Verified by model-call-scan.

## Current tests / cost / latency evidence
- New: `src/agent/approvals/__tests__/financial-rule.test.ts` (13 cases). Zero model calls / tokens.

## Tenant / permission / audit propagation
- Rule is tenant-agnostic; tenant isolation already enforced upstream (G11 policy, checked before autonomy). Reason codes flow into the NEEDS_APPROVAL audit trail.

## Likely bypass paths (all closed)
- Autonomous big spend — closed: amount > ceiling ⇒ require_approval.
- Autonomous on an unverifiable amount — closed: missing/float/negative amountNano ⇒ require_approval (fail-closed).
- Skipping payroll approval — closed: always-approve categories require approval regardless of amount.
- Float money sneaking through — closed: readAmountNano rejects non-integer/negative.

## Proposed migration boundary
- One rule under the SPEC-111 autonomy engine; owner-tunable config (ceiling, categories) supplied at construction. Feature modes at integration wiring.

## Files expected to change
- `src/agent/approvals/financial-rule.ts` (new), `__tests__/financial-rule.test.ts` (new), `artifacts/SPEC-113/**`.
