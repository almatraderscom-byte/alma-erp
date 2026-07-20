# SPEC-149 architecture scan
- No model/provider/tool/DB/clock/RNG (integer arithmetic only; per-step cost injected from the G03 estimator seam).
- Ownership-zone diff: only `src/agent/browser-runtime/**`.
- Forbidden-import gate PASS at group checkpoint.
- No secret surface. Money is integer nano-USD (no float).
