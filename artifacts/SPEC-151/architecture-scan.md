# SPEC-151 Architecture Scan

## Forbidden-dependency / one-way rule (ERP must not import agent)
```text
$ rg -n "@/agent/models|agent/providers/runtime" src/app src/lib
NO MATCHES — one-way dependency intact
$ node scripts/architecture/check-forbidden-imports.mjs
PASS — no NEW forbidden imports. ERP app/api → agent: 0. Boundary did not regress. (101 baselined)
```

## Direct model / provider / tool / network / db call scan (owned zones)
```text
$ rg -n "fetch\(|axios|https?://|new WebSocket|\bnet\.|\bdns\." src/agent/models src/agent/providers/runtime
NONE — no real network/provider call. Only the deterministic FAKE adapter ships.
```

## Ownership-zone diff check
All changes confined to `src/agent/models`, `src/agent/providers/runtime`,
`artifacts/SPEC-151`. Frozen Hermes / live schema / legacy `src/agent/lib/models`: 0 touched.

## Secret & payload leakage scan
```text
$ rg -ni "api[_-]?key|secret|bearer|process\.env\..*KEY" src/agent/models src/agent/providers/runtime
NONE
```
Result: **PASS**.
