# SPEC-080 — Baseline (monolithic registry removal gate)

Parent: SPEC-079 (`299c72b2`). Owned zones: registry, manifests.

The monolith `src/agent/tools/registry.ts` (1041 lines) is still the live runtime
tool surface (Hermes + assistant routes import it). There is currently NO
machine-checked precondition for whether it can be safely retired.

Discovery:
```
$ grep -rn "from '@/agent/tools/registry'" src/app src/agent | wc -l   # live callers
$ wc -l src/agent/tools/registry.ts                                    # 1041
```

Migration boundary: a fail-closed gate that certifies removal readiness across all
G08 facets (parity, schema, classify, ownership, deprecation, io, buildable) plus
the operational cutover — WITHOUT deleting anything (INV-09; production is out of
the owned zone and stays authoritative until evidence + owner sign-off).

Files expected: `removal-gate.ts`, tests, `index.ts` update.
