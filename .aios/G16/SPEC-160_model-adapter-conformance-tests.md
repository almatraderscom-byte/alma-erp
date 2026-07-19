# SPEC-160 — Model adapter conformance tests

**Group:** G16 — Model Fabric and Provider Adapters  
**Position in group:** 10/10  
**Direct prerequisite:** SPEC-159  
**Group prerequisites:** G03, G05  
**Status:** Architecture-frozen candidate

## Mission

Implement model adapter conformance tests as a production-grade, typed, audited and testable boundary for Alma ERP.

This spec is one checkpoint inside a ten-spec group. The coding agent must complete, verify, commit and record evidence for this spec before opening the next spec. A failure stops the whole group.

## Non-negotiable invariants

1. Do not add an LLM call for deterministic validation, routing, permission, budget arithmetic or postcondition checking.
2. Every authoritative operation carries tenant, actor, agent, workflow, step and correlation identities.
3. Every model call is pre-authorized by the Cost Governor once that component exists.
4. Every external side effect goes through the Tool Gateway once that component exists.
5. Permissions and approvals fail closed.
6. Unknown external outcomes enter reconciliation; they are never blindly retried.
7. Full provider/tool payloads stay in evidence storage; models receive bounded views.
8. New behavior is feature-flagged and rollback-tested.
9. Existing public behavior remains compatible until migration evidence passes.
10. Completion requires executable proof, not an explanation.

## Owned zones

- `src/agent/models`
- `src/agent/providers/runtime`

The session may inspect the whole repository but should edit only these zones plus the spec proof directory. Shared choke points such as `prisma/schema.prisma`, root lockfiles and CI configuration are edited only by the group integration checkpoint.

## Required repository discovery

Before code changes, create:

```text
artifacts/SPEC-160/baseline.md
```

It must include:

- current implementation and aliases
- all callers and downstream dependencies
- direct provider/model/tool/database calls
- current tests
- current cost and latency evidence when applicable
- tenant, permission and audit propagation
- likely bypass paths
- proposed migration boundary
- files expected to change

Search results must be recorded with exact commands. Do not rely on filenames assumed by this document.

## Target component contract

Every new boundary must expose a typed request/result contract equivalent to:

```ts
export interface ExecutionIdentity {
  tenantId: string;
  businessId?: string;
  actorId: string;
  agentId?: string;
  workflowId: string;
  stepId: string;
  correlationId: string;
}

export interface ComponentRequest<T> {
  identity: ExecutionIdentity;
  contractVersion: string;
  payload: T;
  policyVersion?: string;
  budgetId?: string;
}

export type ComponentResult<T> =
  | {
      status: "COMPLETED" | "ALLOWED";
      value: T;
      evidenceIds: string[];
      versions: Record<string, string>;
    }
  | {
      status:
        | "DENIED"
        | "NEEDS_APPROVAL"
        | "BUDGET_EXCEEDED"
        | "RETRYABLE"
        | "FAILED_FINAL"
        | "UNKNOWN_OUTCOME";
      reasonCodes: string[];
      evidenceIds: string[];
      retryAfterMs?: number;
      approvalRequestId?: string;
    };
```

The exact types may differ, but ambiguous boolean success and untyped exceptions are prohibited.

## Implementation sequence

### Step 1 — Contract

- Define TypeScript types and runtime validation.
- Define finite reason codes.
- Define audit event and metrics fields.
- Add contract tests before implementation.

### Step 2 — Core behavior

- Implement the smallest deterministic core.
- Keep provider, database and framework details behind adapters.
- Reject missing identity or tenant context.
- Bound input sizes, output sizes, retries and execution time.
- Never silently fall back to a stronger or more expensive model.

### Step 3 — Migration adapter

- Wrap the current implementation.
- Migrate one representative production path.
- Compare old and new behavior in shadow mode.
- Add a detector for unmigrated callers.
- Migrate remaining callers only after the representative path passes.

### Step 4 — Enforcement

Provide feature modes:

```text
off      -> legacy only
shadow   -> legacy authoritative, new path compared
warn     -> new checks report violations
enforce  -> new path authoritative
rollback -> immediate legacy or last-known-good path
```

### Step 5 — Documentation

Update the group architecture record with:

- public contract
- data ownership
- failure behavior
- cost behavior
- security boundary
- operational runbook
- rollback command
- unresolved risks

## Verification requirements

### Unit verification

- valid input
- malformed input
- missing tenant
- missing actor
- oversized input
- timeout
- retryable dependency error
- final dependency error
- permission/budget denial where relevant
- stable reason-code mapping

### Integration verification

- one real repository flow
- exact audit correlation
- cost record correlation where applicable
- feature-flag shadow comparison
- rollback execution
- cross-tenant rejection
- duplicate/replay behavior
- existing API compatibility

### Architecture verification

- static search for bypasses
- forbidden-import test
- direct model/provider/tool call scan
- ownership-zone diff check
- secret and payload leakage scan

### Cost verification

Record before and after:

- model calls
- input tokens
- cached input tokens
- output/reasoning tokens
- tool calls
- estimated USD
- actual USD
- latency
- successful outcome rate

A cost increase fails unless the spec explicitly requires it and measured quality gains are approved.

## Required proof files

```text
artifacts/SPEC-160/
  baseline.md
  contract.md
  changed-files.md
  test-results.md
  architecture-scan.md
  cost-before-after.md
  security-proof.md
  rollback-proof.md
  unresolved-risks.md
  final-verdict.md
```

`final-verdict.md` must be `PASS`, `PARTIAL` or `FAIL`. Only `PASS` allows the Group Runner to continue automatically.

## Acceptance checklist

- [ ] Repository baseline completed before edits.
- [ ] Typed and runtime-validated contract exists.
- [ ] Tests demonstrate success and failure paths.
- [ ] Tenant and identity propagation is proven.
- [ ] No new uncontrolled model call exists.
- [ ] No unauthorized external side-effect path exists.
- [ ] Cost impact is measured.
- [ ] Rollback is tested.
- [ ] Bypass scan passes.
- [ ] Proof artifacts are complete.
- [ ] Final verdict is `PASS`.

## Coding-agent command

```text
Execute SPEC-160 only.

Read the group RUNNER.md and this spec fully.
Inspect the live repository rather than trusting assumed paths.
Create baseline proof before production edits.
Do not edit another group's owned zones.
Do not continue to the next spec unless every acceptance item passes.
Commit with message: "SPEC-160: Model adapter conformance tests".
Write all required proof artifacts.
Return PASS, PARTIAL or FAIL and stop.
```
