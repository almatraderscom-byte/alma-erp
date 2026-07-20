# SPEC-167 Security Proof — De-escalation after planning

- Identity/tenant carried on routing decisions; missing identity fails closed.
- Deterministic: no LLM/provider/network call, no secrets in owned zones (scan NONE).
- **No frontier head model as default** — router excludes the frontier tier from
  default candidates; frontier is reachable only via explicit escalation + budget.
- One-way dependency intact (forbidden-import gate PASS).
Result: **PASS**.
