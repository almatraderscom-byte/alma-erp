# SPEC-066 Architecture Scan — Semantic read-only response cache

## Forbidden-dependency / bypass scan (one-way rule: ERP must not import agent)

```text
$ rg agent/cache in ERP
NO MATCHES — one-way dependency intact
```

## Direct model / provider / tool / database call scan (new code)

```text
# cache must be deterministic — no provider/model CALL:
  NONE — deterministic caching (INV-01)
```

## Ownership-zone diff check

All changes are confined to owned zones (`docs/architecture`,
`scripts/architecture`, `src/agent/contracts`) plus `artifacts/SPEC-066`.
See `changed-files.md`.

## Executable gate

```text
$ node scripts/architecture/check-forbidden-imports.mjs
known (baselined) pre-existing violations: 101
PASS — no NEW forbidden imports. ERP app/api → agent: 0. Boundary did not regress.
```

Result: **PASS** — no bypass, no uncontrolled provider/model/tool call, no
ownership-zone violation.

