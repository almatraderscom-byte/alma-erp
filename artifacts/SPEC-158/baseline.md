# SPEC-158 Baseline — Provider timeout and quota controls
## Discovery
```text
$ rg -n "timeout|quota" src/agent/providers/runtime  → NONE (adapter carries timeoutMs, not enforced)
$ rg -n "attemptRunner" src/agent/models/fabric.ts    → optional seam present (SPEC-151), no impl
```
- Current: adapters carry a `timeoutMs` but nothing enforces it; no quota.
- Direct provider/network calls: none (deterministic; injected `now()`).
- Tests: 62 green pre-spec.
- Bypass paths: an unbounded/over-rate provider call. Prevented: quota deny →
  provider not called; over-budget elapsed → TIMEOUT (RETRYABLE), reservation released.
- Migration boundary: additive; provide the guarded `AttemptRunner`; callers pass
  a long-lived quota controller.
- Files expected: `providers/runtime/timeout-quota.ts` (new),
  `models/attempt-runner.ts` (new), barrels, tests, artifacts.
