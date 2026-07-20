# SPEC-001 Contract — Canonical component request/result

Module: `src/agent/contracts/component.ts` (contract version `1.0.0`).

## Public contract

- `ExecutionIdentity` — tenantId, businessId?, actorId, agentId?, workflowId,
  stepId, correlationId.
- `ComponentRequest<T>` — identity, contractVersion, payload, policyVersion?,
  budgetId?.
- `ComponentResult<T>` = `ComponentSuccess<T>` (`COMPLETED` | `ALLOWED`) |
  `ComponentFailure` (`DENIED` | `NEEDS_APPROVAL` | `BUDGET_EXCEEDED` |
  `RETRYABLE` | `FAILED_FINAL` | `UNKNOWN_OUTCOME`). **No boolean success.**
- `REASON_CODES` — finite, append-only string set (MISSING_TENANT, MISSING_ACTOR,
  MALFORMED_INPUT, OVERSIZED_INPUT, CONTRACT_VERSION_MISMATCH, CROSS_TENANT, …).
- `AuditEvent`, `OperationMetrics` — audit + metric field shapes.

## Runtime validation

- `executionIdentitySchema`, `componentRequestSchema(payload)` — zod.
- `validateRequest(raw, payloadSchema, version)` → typed request **or**
  `ComponentFailure`; never throws. Enforces identity presence, contract-version
  match, and `MAX_PAYLOAD_BYTES` (256 KiB) size bound.
- `mapZodToReasonCodes()` — deterministic zod-issue → finite reason-code mapping.

## Constructors

`completed()`, `allowed()`, `failure(status, reasonCodes, opts)`, `isSuccess()`.

## Data ownership

Pure library. Owns no data, no I/O, no provider/model/tool/db access.

## Failure behaviour

All failure is returned as a typed `ComponentFailure` with finite reason codes.
Invalid input never throws across the boundary.

## Cost behaviour

Zero model calls, zero tokens, zero USD (see `cost-before-after.md`).

## Security boundary

Deterministic validation only (invariant #1: no LLM for validation/routing).
No secrets, no network. One-way dependency respected.

## Rollback command

```
git revert --no-edit <SPEC-001 commit>   # removes added files; production inert
```

See `rollback-proof.md` for the executed drill.
