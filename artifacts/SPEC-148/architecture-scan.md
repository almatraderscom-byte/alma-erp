# SPEC-148 architecture scan
- No model/provider/tool/DB/clock/RNG (pure counters).
- Ownership-zone diff: only `src/agent/browser-runtime/**`.
- Forbidden-import gate PASS at group checkpoint.
- Signatures are opaque hashes; no secret surface.
