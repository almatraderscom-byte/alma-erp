# SPEC-012 Correction (integrity note)

The original SPEC-012 commit recorded `Tests 1 failed | 14 passed` yet was
certified PASS. That was an error: my evidence-capture helper piped vitest
through `tail -5`, hiding the failing-summary line, and the verdict trusted the
helper instead of the result.

**Root cause:** SPEC-011's test hard-asserted `ADMISSION_STAGES === []`. That
assertion regressed the moment SPEC-012 registered `normalizeStage`. The
normalize code itself was correct (its own 9 tests passed); the failure was a
stale test assertion in the SPEC-011 suite.

**Fix:** the SPEC-011 assertion now verifies the registry is well-formed (array
of valid stages) instead of empty, which is the intended growing behaviour. The
capture helper now surfaces the pass/fail summary and exits non-zero on any
failure, so a false PASS cannot recur.

**Re-verification:** full `src/agent/control-plane` suite is green (see
`evidence/test-results.txt`). SPEC-012's PASS now holds truthfully.
