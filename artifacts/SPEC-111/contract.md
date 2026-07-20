# SPEC-111 Contract — Autonomy decision states

## Public surface (`src/agent/autonomy/states.ts`)
- `AutonomyState = 'AUTONOMOUS' | 'NEEDS_APPROVAL' | 'DENIED'`.
- `AutonomyEngine` (immutable rule list) `.decide(input): ComponentResult<AutonomyDecisionValue>`, `.ruleNames()`; `decideAutonomy(input, rules)`; `autonomyStateOf(decision)`.
- `ApprovalRule { name, evaluate(input): ApprovalVerdict }`; `ApprovalEffect = 'require_approval' | 'autonomous_ok' | 'abstain'`.
- `AutonomyInput { identity, action: ActionDescriptor, policyDecision: PolicyDecision, context? }`.
- `AUTONOMY_REASON_CODES`: POLICY_DENIED, APPROVAL_REQUIRED, UNCLASSIFIED_REQUIRES_APPROVAL, MALFORMED_REQUEST.

## Result shape
- Reuses G01 `ComponentResult`: AUTONOMOUS = `{status:'ALLOWED', value}`; `{status:'NEEDS_APPROVAL'|'DENIED', reasonCodes}`. No boolean, no throw.

## Reducer (fail-closed toward ASK, INV-05)
1. malformed action → NEEDS_APPROVAL. 2. policy not ALLOWED → DENIED (+policy reasons). 3. any rule require_approval → NEEDS_APPROVAL (override). 4. ≥1 routine, none require → AUTONOMOUS. 5. else → NEEDS_APPROVAL (unclassified).

## Failure / cost / security
- Never throws; every non-autonomous path is a typed NEEDS_APPROVAL/DENIED. Cost: 0 model calls (INV-01). Rule list frozen (defensive copy) — post-construction injection impossible.

## Rollback
`git revert --no-edit <SPEC-111 commit>` — restores exact pre-spec tree.
