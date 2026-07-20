# SPEC-160 Baseline — Model adapter conformance tests
## Discovery
```text
$ rg -n "conformance" src/agent/providers/runtime  → NONE
$ rg -n "ProviderAdapter" src/agent/providers/runtime/adapter.ts → the contract to conform to (SPEC-151)
$ ls src/agent/providers/runtime  → adapter, fake-adapter, capabilities, timeout-quota, failover
```
- Current: adapter interface + FAKE adapter (SPEC-151) and all runtime pieces; no
  executable conformance definition binding them.
- Direct provider/network calls: none — harness runs against the FAKE only.
- Tests: 75 green pre-spec.
- Bypass paths: a non-conforming adapter (unbounded output, non-JSON, flaky)
  reaching the fabric. Prevented: harness gates adapters, catches each violation.
- Migration boundary: additive; the harness is the readiness gate for future real
  SDK adapters (run against recorded fixtures, no live call).
- Files expected: `providers/runtime/conformance.ts` (new), barrel, tests, artifacts.
