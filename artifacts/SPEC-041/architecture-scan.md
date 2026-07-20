# SPEC-041 Architecture Scan — Versioned context-compiler contract

## Forbidden-dependency / bypass scan (one-way rule: ERP must not import agent)

```text
$ rg -n "agent/context|agent/prompts" src/app src/lib
NO MATCHES — one-way dependency intact
```

## Direct model / provider / tool / database call scan (new code)

```text
# context assembly must be deterministic — no provider/model/db CALL:
  NONE — context compiler is deterministic (INV-01)
```

## Ownership-zone diff check

All changes are confined to owned zones (`docs/architecture`,
`scripts/architecture`, `src/agent/contracts`) plus `artifacts/SPEC-041`.
See `changed-files.md`.

## Executable gate

```text
$ node scripts/architecture/check-forbidden-imports.mjs
known (baselined) pre-existing violations: 101
PASS — no NEW forbidden imports. ERP app/api → agent: 0. Boundary did not regress.
```

Result: **PASS** — no bypass, no uncontrolled provider/model/tool call, no
ownership-zone violation.

