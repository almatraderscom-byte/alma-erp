# SPEC-073 — Baseline (domain tool package structure)

Parent: SPEC-072 (`238d511d`). Owned zones: registry, manifests.

Today the monolith flattens all tools into pool arrays (`TOOLS`, `TRADING_TOOLS`,
…) and 14 routing groups; there is NO per-domain package boundary. The 63 domains
exist only as a `domain` string label in `capability-classification.ts`.

Discovery:
```
$ node -e "require('/tmp/g08-inventory.json')"  # 326 tools, 63 domains
$ grep -c "domain:" src/agent/tools/capability-classification.ts   # label only, no packaging
```

Migration boundary: introduce a first-class `DomainPackage` (all manifests for
one domain, validated together) and generate the 63 packages from the SPEC-071
inventory snapshot — the flat monolith becomes domain-partitioned data, with a
loader that aggregates + globally validates.

Files expected: `domain-package.ts`, `derive-side-effects.ts`,
`scripts/build-domain-manifests.ts`, `domains.generated.ts` (generated),
`loader.ts`, tests, `index.ts` update.
