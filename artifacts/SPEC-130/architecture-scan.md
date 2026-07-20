# SPEC-130 — Architecture scan
`bypass-gate.ts` is pure string scanning (no imports beyond none). The `.mjs`
runner is dependency-free (node:fs/path only). Deterministic (INV-01). No ERP→agent
import. Ownership diff: only tool-gateway + artifacts/SPEC-130. The gate itself
proves no external side-effect bypasses the gateway seam. PASS.
