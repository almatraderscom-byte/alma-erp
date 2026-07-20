# SPEC-071 — Security proof

## Identity / tenant isolation

`queryInventory` runs G01 `validateRequest` before any work: a request missing
`tenantId`/`actorId`/`workflowId`/`stepId`/`correlationId` is rejected
`FAILED_FINAL` with the matching finite reason code (tests:
"missing tenant …", "missing actor …"). Fail-closed (INV-05).

The inventory is global tool metadata (not tenant-scoped business data), so there
is no cross-tenant data path to leak; identity is still enforced so callers can
never invoke the boundary anonymously.

## Secret / payload leakage scan

```
$ grep -rnE "(api[_-]?key|secret|token|password|DATABASE_URL|BEGIN [A-Z]+ PRIVATE)" \
    src/agent/tools/registry/
# (none)
```

The snapshot contains only tool names + domain/mode/risk/groups/pools — no
secrets, no payloads, no PII. Full payloads stay in the handlers (INV-07); this
boundary carries a bounded metadata view only.

## Fail-closed

Malformed / null / non-object input → `FAILED_FINAL`, never a throw and never a
default-allow (test: "never throws across the boundary").

PASS.
