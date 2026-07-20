# SPEC-128 — Baseline (evidence capture stage)
Parent: SPEC-127 (`7011acbd`). Owned zone: src/agent/tool-gateway.

G10 provides the evidence store + boundedOutputView (G08) + provenance shape.
The gateway must capture the full result and hand the model only a bounded,
obligation-redacted, provenanced view (INV-07).
Discovery:
```
$ grep -an "export const evidenceStore\|InMemoryEvidenceStore" src/agent/tools/results/evidence-store.ts
$ grep -n "export function boundedOutputView" src/agent/tools/registry/io-schema.ts
$ grep -n "interface Provenance" src/agent/tools/results/provenance.ts
```
Migration boundary: store raw → obligation-redact → bound+secret-redact → stamp
provenance.
Files: stages/evidence-capture.ts, gateway.ts (edit), index.ts (edit), tests.
