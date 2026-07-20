# SPEC-128 — Test results
`npx vitest run src/agent/tool-gateway`
```
 Test Files  8 passed (8)
      Tests  46 passed (46)     # 8+5+5+5+5+8+5+5
```
Scoped tsc: 0. Full-repo tsc: 0.
Cases → tests: full payload stored + bounded provenanced view returned; obligations
(redact) applied before bounding (secret not in view, evidence retains full);
secret keys redacted in view; no payload → FAILED_FINAL; never throws.
