# SPEC-005 Baseline — Tenant & business context propagation
No canonical tenant guard existed; isolation was implicit per query. This spec
adds the fail-closed guard on top of SPEC-004 identity. No provider/model/db
calls. Zero cost. Additive files only:
- `src/agent/contracts/tenant-context.ts` (+test)
- `docs/architecture/tenant-context.md`
