# SPEC-001 Changed Files

All additive; confined to owned zones + proof dir.

```
src/agent/contracts/component.ts                     (new) canonical contract
src/agent/contracts/__tests__/component.test.ts      (new) 9 tests
src/agent/contracts/tsconfig.json                    (new) scoped typecheck
scripts/architecture/_shared.mjs                     (new) shared walker
scripts/architecture/inventory.mjs                   (new) inventory scanner
docs/architecture/request-path-map.md                (new) frozen request path
docs/architecture/inventory.json                     (new) generated snapshot
artifacts/SPEC-001/**                                (new) proof
```

No existing production file modified. Verified via `git show --stat`.
