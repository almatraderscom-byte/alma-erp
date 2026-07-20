# SPEC-071 — Test results

Command: `npx vitest run src/agent/tools/registry`

```
 Test Files  1 passed (1)
      Tests  14 passed (14)
```

Scoped typecheck — errors inside owned zones `src/agent/tools/{registry,manifests}`:
```
$ npx tsc --noEmit -p tsconfig.json 2>&1 | grep -cE 'src/agent/tools/(registry|manifests)/'
0
```

Full-repo typecheck (regression guard): `0` total `error TS` lines.

## Coverage of the spec's required unit cases

| required case                     | test |
|-----------------------------------|------|
| valid input                       | "returns COMPLETED for a valid get", "summary query rolls up" |
| malformed input                   | "malformed payload fails closed" |
| missing tenant                    | "missing tenant fails closed with MISSING_TENANT" |
| missing actor                     | "missing actor fails closed with MISSING_ACTOR" |
| contract-version mismatch         | "contract-version mismatch is rejected" |
| never throws across boundary      | "never throws across the boundary (null / garbage input)" |
| stable reason-code mapping        | asserts REASON_CODES.MISSING_TENANT/ACTOR/CONTRACT_VERSION_MISMATCH |
| snapshot integrity (326, sums)    | "captured the full monolith surface", "names unique + sorted" |

Oversized-input / timeout / retryable-dependency cases are N/A for a read-only,
in-memory metadata boundary (no external dependency, no unbounded input path):
the 256 KiB bound is still enforced by the shared `validateRequest`.
