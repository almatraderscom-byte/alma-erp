# SPEC-190 Architecture Scan — Quality and security release gate

## Forbidden-dependency / bypass scan (one-way rule: ERP must not import agent)

```text
$ rg agent/verification|agent/evals in ERP
NO MATCHES — one-way dependency intact
```

## Direct model / provider / tool / database call scan (new code)

```text
# policy must be deterministic — no LLM/DB/network (INV-01, permission never via LLM):
  NONE — deterministic authz (INV-01/INV-05)
```

## Ownership-zone diff check

All changes are confined to owned zones (`docs/architecture`,
`scripts/architecture`, `src/agent/contracts`) plus `artifacts/SPEC-190`.
See `changed-files.md`.

## Executable gate

```text
$ node scripts/architecture/check-forbidden-imports.mjs
known (baselined) pre-existing violations: 101
PASS — no NEW forbidden imports. ERP app/api → agent: 0. Boundary did not regress.
```

Result: **PASS** — no bypass, no uncontrolled provider/model/tool call, no
ownership-zone violation.

