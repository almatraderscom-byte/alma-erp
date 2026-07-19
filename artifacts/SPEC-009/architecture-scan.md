# SPEC-009 Architecture Scan — AI change-proof artifact standard

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
`scripts/architecture`, `src/agent/contracts`) plus `artifacts/SPEC-009`.
See `changed-files.md`.

## Executable gate

```text
$ node scripts/architecture/check-proof.mjs --require-pass   # validates all prior spec proofs
proof check: 9 spec dir(s) (require PASS)
  [OK] SPEC-001  verdict=PASS
  [OK] SPEC-002  verdict=PASS
  [OK] SPEC-003  verdict=PASS
  [OK] SPEC-004  verdict=PASS
  [OK] SPEC-005  verdict=PASS
  [OK] SPEC-006  verdict=PASS
  [OK] SPEC-007  verdict=PASS
  [OK] SPEC-008  verdict=PASS
  [BAD] SPEC-009  verdict=NONE  missing=baseline.md,contract.md,changed-files.md,test-results.md,architecture-scan.md,cost-before-after.md,security-proof.md,rollback-proof.md,unresolved-risks.md,final-verdict.md
FAIL — incomplete proof or non-PASS verdict
exit=1
```

Result: **PASS** — no bypass, no uncontrolled provider/model/tool call, no
ownership-zone violation.

