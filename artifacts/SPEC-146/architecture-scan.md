# SPEC-146 architecture scan
- No model/provider/tool/DB/clock/RNG in the core (planning + page I/O are adapter seams).
- Ownership-zone diff: only `src/agent/browser-runtime/**`.
- Forbidden-import gate: zone is `agent`; imports only `@/agent/contracts`. No ERP→agent edge. PASS at group checkpoint.
- No secret leakage: perception exposes opaque `ref` + label, never raw selectors/URLs-with-secrets (urlRef is host+path).
