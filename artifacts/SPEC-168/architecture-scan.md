# SPEC-168 Architecture Scan — Frontier head planner contract

## Forbidden-dependency / one-way rule (ERP must not import agent)
```text
$ rg -n "@/agent/routing|@/agent/runtime" src/app src/lib   → NO MATCHES — intact
$ node scripts/architecture/check-forbidden-imports.mjs
PASS — no NEW forbidden imports. ERP app/api → agent: 0. Boundary did not regress.
```

## Real network / provider call scan (owned zones)
```text
NONE
```

## Secret / key scan (owned zones)
```text
NONE
```
Result: **PASS** — no bypass, no real provider call, no secret, changes confined to owned zones.
