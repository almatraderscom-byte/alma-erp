# SPEC-141 security proof

- **Tenant isolation (INV-02)**: enqueue rejects when `taskIdentity.tenantId != request.identity.tenantId` (DENIED/CROSS_TENANT); dequeue only returns tasks whose `identity.tenantId` matches the requester. Tests: "rejects a cross-tenant enqueue", "never returns another tenant's task".
- **Fail-closed (INV-05)**: missing identity ⇒ DENIED/MISSING_IDENTITY; malformed ⇒ FAILED_FINAL/MALFORMED; empty queue ⇒ RETRYABLE (never a thrown exception, never a silent success).
- **Bounded view (INV-07)**: only a `payloadRef` (<=1KiB) is stored/audited; full payload stays in evidence storage.
- **No secret leakage**: audit event contains identity ids + reason codes only.
