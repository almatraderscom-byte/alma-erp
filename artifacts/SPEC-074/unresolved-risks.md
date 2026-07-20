# SPEC-074 — Unresolved risks
1. Only 2 tools carry curated strict schemas; the other 324 use a permissive
   default pending per-tool migration of handler schemas. This is intentional
   (migration is tool-by-tool) and safe (permissive default never false-rejects).
   Severity: low. Tracked for the runtime-registry wiring (SPEC-079) and beyond.
Unresolved critical risks: 0.
