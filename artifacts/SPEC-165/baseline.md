# SPEC-165 Baseline — Explicit escalation reason contract
## Discovery
```text
$ rg -n "escalation|EscalationReason" src/agent/routing → NONE
$ rg -n "tierRank" src/agent/models/tiers.ts             → G16 tier rank available
```
- Current: measured router refuses frontier as default (SPEC-164). No escalation path yet.
- Direct provider/db calls: none — pure validation.
- Tests: 25 green pre-spec.
- Bypass paths: implicit/casual escalation to frontier. Prevented — reason required,
  must move upward, frontier needs a frontier-eligible reason (fail-closed).
- Migration boundary: additive; budget enforcement layered in SPEC-166.
- Files expected: routing/escalation-reason.ts, index.ts, tests, artifacts.
