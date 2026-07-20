# SPEC-072 — Test results

`npx vitest run src/agent/tools/manifests`
```
 Test Files  1 passed (1)
      Tests  18 passed (18)
```
Combined owned-zone suite `npx vitest run src/agent/tools/registry src/agent/tools/manifests`:
```
 Test Files  2 passed (2)
      Tests  32 passed (32)
```
Scoped typecheck (owned zones): 0 errors. Full-repo `tsc`: 0 errors.

Required cases → tests:
| valid input | "accepts a well-formed manifest", "accepts a deprecated manifest" |
| malformed input | missing field / non-snake_case / bad semver / unknown mode/risk / unknown side-effect / empty / none-combine / duplicate |
| missing tenant | "missing tenant fails closed" |
| stable reason codes | MISSING_TENANT, MALFORMED_INPUT asserted |
| never throws | "never throws on garbage" |
| closed taxonomy | "side-effect kinds are the frozen set" |
