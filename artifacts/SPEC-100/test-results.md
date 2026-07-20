# SPEC-100 — Test results
`npx vitest run src/agent/tools/selection src/agent/tools/results`
```
 Test Files  10 passed (10)
      Tests  82 passed (82)     # selection 38 + results 44
```
Owned-zone tsc: 0. Full-repo tsc: 0.

IMPORTANT (honest record): the FIRST gate run FAILED the VIEW_BOUNDED check — the
compact model view's truncated envelope (wrapper + JSON-escaped preview) serialized
to 4654 bytes, over the 4096 cap. This was a REAL bound bug in SPEC-096's
model-view.ts. Fix: trim the preview deterministically until the whole envelope
fits `cap`. Re-run: VIEW_BOUNDED = 4016 ≤ 4096, all 8 checks PASS, certified true.
PASS was NOT certified until BOTH the vitest summary AND tsc were clean.

Cases → tests: all 8 checks pass; certified no blockers; 8 checks; secret 'clean'
explicitly; deterministic; boundary certified + identity fail-closed + no-throw +
malformed rejected.
