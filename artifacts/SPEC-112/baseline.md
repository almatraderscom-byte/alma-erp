# SPEC-112 Baseline — Fail-closed approval contract

## Current implementation and aliases
- New in `src/agent/approvals`. Discovery: `find src/agent/approvals -name "*.ts"` → only this spec's files.
- Builds on SPEC-111 `ActionDescriptor`, G11 `Principal`/`principalKey`, G01 `ComponentResult`/`isSuccess`/`ExecutionIdentity`.

## Callers and downstream dependencies
- The autonomy engine (SPEC-111) emits NEEDS_APPROVAL; a caller parks a `newApprovalRequest` and later calls `resolveApproval`. SPEC-118 adds expiry/revocation lifecycle; SPEC-119 audit; the Tool Gateway (G13 SPEC-126) consults this before executing an approval-gated action. Durable storage = later group (queue).

## Direct provider/model/tool/database calls
- None. Pure resolver; `nowMs` passed in (no wall clock) → replayable (INV-01). Verified by model-call-scan.

## Current tests / cost / latency evidence
- New: `src/agent/approvals/__tests__/contract.test.ts` (13 cases). Zero model calls / tokens.

## Tenant / permission / audit propagation
- Approver must be same tenant as the request; grant record stamps `approverKey` + `decidedAtMs` for audit. Identity carried on the request.

## Likely bypass paths (all closed)
- Approve by doing nothing → PENDING (never approved).
- Approve after expiry → EXPIRED (terminal), even with a grant.
- Replay a grant onto another request → REQUEST_MISMATCH (ignored).
- Cross-tenant approver → CROSS_TENANT_APPROVER DENY.
- Non-human (agent) approver → UNAUTHORIZED_APPROVER DENY.
- Requester approving itself → SELF_APPROVAL DENY.
- Grant timestamp outside the live window → DECIDED_OUT_OF_WINDOW DENY.

## Proposed migration boundary
- `resolveApproval` is the single approval decision surface the gateway consults; feature modes at integration wiring.

## Files expected to change
- `src/agent/approvals/contract.ts` (new), `__tests__/contract.test.ts` (new), `artifacts/SPEC-112/**`.
