# SPEC-001 Architecture Scan — Architecture inventory and request-path map

## Forbidden-dependency / bypass scan (one-way rule: ERP must not import agent)

```text
$ rg -n "agent/contracts" src/app src/lib (ERP zones must NOT import agent)
NO MATCHES — one-way dependency intact
```

## Direct model / provider / tool / database call scan (new code)

```text
$ rg -n "fetch\(|googleapis|openrouter|anthropic|prisma" src/agent/contracts scripts/architecture
NO provider/model/db calls in contracts (deterministic, pure)
```

## Ownership-zone diff check

All changes are confined to owned zones (`docs/architecture`,
`scripts/architecture`, `src/agent/contracts`) plus `artifacts/SPEC-001`.
See `changed-files.md`.

Result: **PASS** — no bypass, no uncontrolled provider/model/tool call, no
ownership-zone violation.

