# SPEC-071 — Unresolved risks

1. **Snapshot staleness.** `inventory.data.ts` is a point-in-time capture. If the
   monolith adds/removes a tool, the snapshot drifts until regenerated. Mitigation
   planned in SPEC-080 (removal gate compares live monolith vs manifests) and a
   CI regen check could be added by the integration session. Severity: low
   (additive; drift is detectable, never a silent wrong-answer at runtime).

2. **Directory/file name coexistence.** `registry.ts` and `registry/` coexist.
   Resolution is deterministic today (bare specifier → file), confirmed by a clean
   full-repo typecheck, but is a latent footgun. SPEC-080 tracks the eventual
   monolith removal that dissolves it.

No critical (money/security/tenant) risks unresolved. Count of unresolved
critical risks: **0**.
