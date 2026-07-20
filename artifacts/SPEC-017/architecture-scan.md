# SPEC-017 Architecture Scan — Planning-need classification

## Forbidden-dependency / bypass scan (one-way rule: ERP must not import agent)

```text
$ rg -n "control-plane" src/app src/lib   (ERP must NOT import agent control-plane)
NO MATCHES — one-way dependency intact
```

## Direct model / provider / tool / database call scan (new code)

```text
# admission code must be deterministic — no direct provider/model/db call:
$ rg -n "fetch\(|googleapis|openrouter|anthropic|@prisma/client|\$queryRaw" src/agent/control-plane
  NONE — admission plane is deterministic (INV-01); model calls happen later via Cost Governor
```

## Ownership-zone diff check

All changes are confined to owned zones (`docs/architecture`,
`scripts/architecture`, `src/agent/contracts`) plus `artifacts/SPEC-017`.
See `changed-files.md`.

## Executable gate

```text
$ node scripts/architecture/check-forbidden-imports.mjs (ERP must not import agent/control-plane)
known (baselined) pre-existing violations: 101
PASS — no NEW forbidden imports. ERP app/api → agent: 0. Boundary did not regress.
exit=0
```

Result: **PASS** — no bypass, no uncontrolled provider/model/tool call, no
ownership-zone violation.

