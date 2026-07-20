# SPEC-153 Architecture Scan — Classifier and extractor T1 tier

## Forbidden-dependency / one-way rule
```text
$ rg -n "@/agent/models|agent/providers/runtime" src/app src/lib   → NO MATCHES — intact
$ node scripts/architecture/check-forbidden-imports.mjs
PASS — no NEW forbidden imports. ERP app/api → agent: 0. Boundary did not regress.
```

## Real network / provider call scan (owned zones)
```text
$ rg -n "fetch\(|axios|https?://|new WebSocket|net\.|dns\." src/agent/models src/agent/providers/runtime
NONE
```

## Secret / key scan (owned zones)
```text
src/agent/models/ARCHITECTURE.md:69:- No secrets, no API keys, no network calls anywhere in the owned zones.
```
Result: **PASS** — no bypass, no real provider call, no secret, changes confined to owned zones.
