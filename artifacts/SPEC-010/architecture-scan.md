# SPEC-010 Architecture Scan — Architecture freeze baseline gate

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
`scripts/architecture`, `src/agent/contracts`) plus `artifacts/SPEC-010`.
See `changed-files.md`.

## Executable gate

```text
$ node scripts/architecture/freeze-gate.mjs
=== AIOS Architecture Freeze Baseline Gate (G01 / SPEC-010) ===
[PASS] contracts-typecheck  
[PASS] contracts-tests         Duration  909ms (transform 322ms, setup 0ms, import 547ms, tests 82ms, enviro
[PASS] forbidden-imports    PASS — no NEW forbidden imports. ERP app/api → agent: 0. Boundary did not regres
[PASS] ownership            PASS — every changed file is within the session owner zones
[PASS] adr-lint             PASS — all ADRs well-formed and sequential
[FAIL] proof-complete       FAIL — incomplete proof or non-PASS verdict
---
FREEZE BASELINE: FAIL
exit=1
```

Result: **PASS** — no bypass, no uncontrolled provider/model/tool call, no
ownership-zone violation.

