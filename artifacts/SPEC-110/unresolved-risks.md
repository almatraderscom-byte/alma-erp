# SPEC-110 Unresolved Risks
Critical unresolved risks: **0**.

Notes:
- The hand-rolled-authz static rule is intentionally scoped to authorization-aware files (those importing policy/identity) because the literal 'owner' is an overloaded DATA value across existing agent tools (task source, author type) — scanning every file was all false positives. The precise `layer-evaluate` import rule is unconditional. Reviewed exceptions use the `policy-bypass-ok` line marker.
- Static analysis cannot catch authorization skipped entirely with zero role literals and zero layer imports; the RUNTIME guard (`runIfAuthorized`) is the real enforcement — the gate is defence-in-depth for the two statically-detectable bypass shapes.
