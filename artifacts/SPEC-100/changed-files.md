# SPEC-100 — Changed files (owned zones)
```
results/regression-gate.ts                  (new) whole-firewall gate + boundary
results/model-view.ts                       (edit) FIX: bound the truncated view to cap
results/index.ts                            (edit) barrel export
results/__tests__/regression-gate.test.ts   (new) 8 tests
artifacts/SPEC-100/*                             proof
```
No live prisma, no production file touched. model-view.ts edit is within the owned
zone (a bug the gate caught).
