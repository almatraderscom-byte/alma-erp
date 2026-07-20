# SPEC-127 — Test results
`npx vitest run src/agent/tool-gateway`
```
 Test Files  7 passed (7)
      Tests  41 passed (41)     # 8+5+5+5+5+8+5
```
Scoped tsc: 0. Full-repo tsc: 0.
Cases → tests: success carries rawPayload + actual cost; RETRYABLE propagates
(retryAfterMs preserved); UNKNOWN_OUTCOME propagates (INV-06); missing adapter →
FAILED_FINAL (fail-closed); never throws. Fake adapter only — no network.
