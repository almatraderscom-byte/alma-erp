# SPEC-112 Contract — Fail-closed approval contract

## Public surface (`src/agent/approvals/contract.ts`)
- `ApprovalRequest { approvalRequestId, identity, action, reasonCodes, createdAtMs, expiresAtMs }`.
- `ApprovalDecisionInput { approvalRequestId, decision:'grant'|'deny', approver:Principal, decidedAtMs, note? }`.
- `newApprovalRequest(id, identity, action, reasonCodes, createdAtMs, ttlMs)` (zod-validated; throws on malformed).
- `resolveApproval(request, decision|null, nowMs): ComponentResult<ApprovalGrant>` — never throws.
- `approvalStateOf(request, decision, nowMs): 'PENDING'|'GRANTED'|'DENIED'|'EXPIRED'`.
- `APPROVAL_REASON_CODES` (append-only).

## Resolution order (fail-closed, INV-05)
1. malformed request → DENIED(MALFORMED). 2. now ≥ expiry → DENIED(EXPIRED) [terminal, checked first]. 3. no decision → NEEDS_APPROVAL(PENDING). 4. wrong request id → NEEDS_APPROVAL(REQUEST_MISMATCH). 5. cross-tenant approver → DENIED. 6. non-human approver → DENIED. 7. self-approval → DENIED. 8. decided outside [createdAt, expiresAt) → DENIED. 9. deny → DENIED. 10. valid in-window grant by authorized human → ALLOWED (grant record).

## Failure / cost / security
- No boolean, no throw across the boundary. Deterministic — `nowMs` injected, no wall clock (INV-01). Approver authorization + tenant + anti-self-approval enforced (SPEC-117 hardens SoD further).

## Rollback
`git revert --no-edit <SPEC-112 commit>` — restores exact pre-spec tree.
