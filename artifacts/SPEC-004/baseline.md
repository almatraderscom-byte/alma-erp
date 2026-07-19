# SPEC-004 Baseline — Canonical execution identity contract
## Discovery
```
$ rg -n "tenantId|correlationId" src/agent | wc -l   # ad-hoc identity usage
```
No single canonical identity builder existed; identity fields were passed
ad hoc. This spec introduces the one builder/validator/propagator.
## Provider/model/db calls
None. Uses node:crypto (local hash) only.
## Cost/latency
Zero model calls.
## Migration boundary
Additive; builds on `component.ts`. Nothing in production imports it yet.
## Files expected to change
- `src/agent/contracts/execution-identity.ts` (+test)
- `docs/architecture/execution-identity.md`
