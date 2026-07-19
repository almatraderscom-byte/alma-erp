# SPEC-003 Architecture Scan — Repository ownership zones and CODEOWNERS model

## Forbidden-dependency / bypass scan (one-way rule: ERP must not import agent)

```text
$ rg -n "agent/contracts" src/app src/lib   (ERP zones must NOT import agent)
NO MATCHES — one-way dependency intact
```

## Direct model / provider / tool / database call scan (new code)

```text
# (1) contract code must be pure — no provider/model/db call:
$ rg -n "fetch\(|googleapis|openrouter|anthropic|@prisma/client|\$queryRaw" src/agent/contracts
  NONE — src/agent/contracts is deterministic & pure

# (2) governance scripts must make no real network call (they only read files):
$ rg -n "fetch\(|node:https|node:http|node-fetch|axios|https\.request" scripts/architecture
  NONE — scripts use only node:fs / node:path (static analysis; provider names appear only as detection regex strings)
```

## Ownership-zone diff check

All changes are confined to owned zones (`docs/architecture`,
`scripts/architecture`, `src/agent/contracts`) plus `artifacts/SPEC-003`.
See `changed-files.md`.

## Executable gate

```text
$ node scripts/architecture/check-ownership.mjs --owner G01   # this session's diff vs main
ownership check: owner=G01, 46 files
PASS — every changed file is within the session owner zones
exit=0

# negative: a G01 session touching ERP must FAIL
$ node scripts/architecture/check-ownership.mjs --owner G01 src/lib/money.ts
ownership check: owner=G01, 1 files
FAIL — 1 ownership violation(s):
  src/lib/money.ts  [OWNERSHIP_CONFLICT owned by erp]
exit=1
```

Result: **PASS** — no bypass, no uncontrolled provider/model/tool call, no
ownership-zone violation.

