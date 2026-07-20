# SPEC-073 — Test results
`npx vitest run src/agent/tools/manifests`
```
 Test Files  2 passed (2)
      Tests  37 passed (37)      # 18 (SPEC-072) + 19 (SPEC-073)
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Determinism: regenerate → `diff` empty (byte-identical).

Cases → tests: full-partition (326/63), global validity, global unique names,
domain agreement, derived side-effects, corruption detection (empty/mismatch/
duplicate/unsorted), cross-domain duplicate, boundary identity fail-closed +
no-throw.
