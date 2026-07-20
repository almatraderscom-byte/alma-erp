# SPEC-024 Architecture Scan — Reasoning and tool-call cost accounting

## Forbidden-dependency / bypass scan (one-way rule: ERP must not import agent)

```text
$ rg -n "agent/finops|agent/providers/pricing" src/app src/lib
NO MATCHES — one-way dependency intact
```

## Direct model / provider / tool / database call scan (new code)

```text
# finops must be deterministic math — no provider/model/db CALL (provider names/URLs as pricing DATA are expected):
$ rg call/import signals: fetch(|node:https|node-fetch|axios|from @anthropic-ai|from @google/(genai|generative-ai)|@prisma/client|\$queryRaw|\$executeRaw
  NONE — cost accounting is pure deterministic math; provider names/URLs appear only as pricing data (INV-01)
```

## Ownership-zone diff check

All changes are confined to owned zones (`docs/architecture`,
`scripts/architecture`, `src/agent/contracts`) plus `artifacts/SPEC-024`.
See `changed-files.md`.

## Executable gate

```text
$ node scripts/architecture/check-forbidden-imports.mjs
known (baselined) pre-existing violations: 101
PASS — no NEW forbidden imports. ERP app/api → agent: 0. Boundary did not regress.
```

Result: **PASS** — no bypass, no uncontrolled provider/model/tool call, no
ownership-zone violation.

