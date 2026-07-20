# SPEC-151 Security Proof

- **Tenant/identity:** every request validated against `executionIdentitySchema`;
  missing tenant/actor/workflow/step/correlation → `FAILED_FINAL` with the
  specific `MISSING_*` reason code BEFORE any provider call (test: "missing tenant").
- **Fail closed:** no cost authorization → provider never invoked (INV-03);
  budget deny → `BUDGET_EXCEEDED`, adapter call count 0 (test asserts).
- **No secrets / keys / network** in owned zones (scan: NONE).
- **Bounded model view (INV-07):** the adapter receives only `payload.prompt`;
  identity internals are never forwarded to the provider (test asserts the exact
  prompt reaches the adapter).
- **One-way dependency:** forbidden-import gate PASS (0 new violations).
Result: **PASS**.
