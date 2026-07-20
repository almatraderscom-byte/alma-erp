# SPEC-087 — Unresolved risks
1. The override store is in-memory (durable persistence is the proposed migration
   territory). Restart clears overrides back to catalog defaults — acceptable for a
   deterministic layer; a durable store implements the same interface later.
   Severity: low. Critical risks: 0.
