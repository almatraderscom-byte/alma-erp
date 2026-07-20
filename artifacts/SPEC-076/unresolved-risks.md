# SPEC-076 — Unresolved risks
1. Generated manifests use one agent team/zone (`@alma/agent`, `src/agent/tools`).
   Finer per-domain CODEOWNERS teams can be authored later without schema change;
   `renderToolCodeowners` already emits a per-domain proposal for that. Severity:
   low (cosmetic granularity; correctness is enforced now).
Unresolved critical risks: 0.
