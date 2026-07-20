# SPEC-160 Contract — Model adapter conformance tests
- `validateOutcome(outcome, call)` → issue strings for a single outcome (kind
  valid; OK usage non-negative ints + valid finishReason + output ≤ ceiling + json
  parseable; RETRYABLE/FINAL carry providerCode).
- `standardSampleCalls(model, provider)` — text + json battery inputs.
- `runAdapterConformance(adapter, {model, sampleCalls?})` → `ConformanceReport`
  (never throws): supports-model, invoke-no-throw, outcome-valid, determinism.
- Passing is required before the fabric routes to an adapter; real SDK adapters
  must pass against recorded fixtures with no live network call.
