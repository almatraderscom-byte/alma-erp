# SPEC-126 — Test results
`npx vitest run src/agent/tool-gateway`
```
 Test Files  6 passed (6)
      Tests  36 passed (36)     # 8+5+5+5+5+8
```
Scoped tsc: 0. Full-repo tsc: 0.
Cases → tests: AUTONOMOUS advances; NEEDS_APPROVAL returns NEEDS_APPROVAL +
approvalRequestId and does NOT execute; DENIED propagated; no engine ⇒ NEEDS_APPROVAL
(fail-closed); never throws; obligations redact/mask a view; no obligations → unchanged.
