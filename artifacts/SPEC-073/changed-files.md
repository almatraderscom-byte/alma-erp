# SPEC-073 — Changed files (owned zone `src/agent/tools/manifests`)
```
domain-package.ts                         (new) package type + validation
derive-side-effects.ts                    (new) deterministic seed
scripts/build-domain-manifests.ts         (new) generator (reads inventory snapshot)
domains.generated.ts                      (new, GENERATED) 63 pkgs / 326 manifests
loader.ts                                 (new) aggregation + boundary
index.ts                                  (edit) barrel exports
__tests__/domain-package.test.ts          (new) 19 tests
artifacts/SPEC-073/*                            proof
```
No monolith file, no choke point touched.
