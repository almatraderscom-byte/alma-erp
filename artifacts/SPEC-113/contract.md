# SPEC-113 Contract — Financial action approval rules

## Public surface (`src/agent/approvals/financial-rule.ts`)
- `FinancialApprovalRule implements ApprovalRule` (`name:'financial'`) from `FinancialRuleConfig`.
- `financialApprovalRule(config)` builder; `readAmountNano(attributes)` (strict nano-USD integer reader).
- `FinancialRuleConfig { autonomousCeilingNano, financialResourceTypes?, financialActionPrefixes?, alwaysApprove? }` (zod-validated).
- `FINANCIAL_REASON_CODES`: OVER_CEILING, AMOUNT_UNKNOWN, ALWAYS_APPROVE, WITHIN_CEILING.

## Behavior (fail-closed, INV-05)
- non-financial → abstain. always-approve category (default payroll) → require_approval. amount unknown/float/negative → require_approval. amount > ceiling → require_approval. else (financial, known, ≤ ceiling) → autonomous_ok.
- Money is integer nano-USD only (no floats/BDT), consistent with G03/G04.

## Failure / cost / security
- evaluate never throws; construction throws on invalid config (owner-authored, tested). Cost: 0 model calls (INV-01). Deterministic.

## Rollback
`git revert --no-edit <SPEC-113 commit>` — restores exact pre-spec tree.
