# SPEC-147 architecture scan
- No model/provider/tool/DB/clock/RNG (pure transform).
- Ownership-zone diff: only `src/agent/browser-runtime/**`.
- Forbidden-import gate PASS at group checkpoint (imports `@/agent/contracts` + local contract only).
- Secret-leakage scan: tests assert values, secret labels, and URL query never appear in the emitted observation.
