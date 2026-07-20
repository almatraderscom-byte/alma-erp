# SPEC-159 Baseline — Provider failover rules
## Discovery
```text
$ rg -n "failover" src/agent/providers/runtime src/agent/models   → NONE
$ rg -n "candidates" src/agent/models/registry.ts                 → tier candidate lists (ordered) exist (SPEC-151)
$ rg -n "createGuardedAttemptRunner" src/agent/models/attempt-runner.ts → single-primary runner (SPEC-158)
```
- Current: single-primary guarded runner (SPEC-158); registry already exposes an
  ordered candidate list per tier.
- Direct provider/network calls: none.
- Tests: 70 green pre-spec.
- Bypass paths: silent tier escalation on failure; retrying a permanent error
  across providers (waste); blind-retrying UNKNOWN. All prevented.
- Migration boundary: additive; failover runner iterates same-tier candidates only.
- Files expected: `providers/runtime/failover.ts` (new), extend
  `models/attempt-runner.ts`, barrels, tests, artifacts.
