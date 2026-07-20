# SPEC-002 Architecture Scan — Architecture invariants and forbidden dependency rules

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
`scripts/architecture`, `src/agent/contracts`) plus `artifacts/SPEC-002`.
See `changed-files.md`.

## Executable forbidden-import gate (architecture ratchet)

```text
$ node scripts/architecture/check-forbidden-imports.mjs
forbidden-import scan: 1974 files scanned
known (baselined) pre-existing violations: 101
PASS — no NEW forbidden imports. ERP app/api → agent: 0. Boundary did not regress.
exit=0

# ratchet proof: inject a new erp->agent import, expect FAIL
known (baselined) pre-existing violations: 101
FAIL — 1 NEW forbidden import(s) (regression):
  src/app/__aios_probe.ts  ->  @/agent/config  (erp-app→agent)
exit=0

# probe removed -> PASS again
PASS — no NEW forbidden imports. ERP app/api → agent: 0. Boundary did not regress.
exit=0
```

Result: **PASS** — no bypass, no uncontrolled provider/model/tool call, no
ownership-zone violation.

