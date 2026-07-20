# SPEC-130 — Baseline (direct external-call bypass gate)
Parent: SPEC-129 (`c3ef2ce4`). Owned zone: src/agent/tool-gateway.

G11 ships a tested `bypass-gate.ts` + `check-authorization-bypass.mjs` runner. G13
mirrors that pattern to enforce that every external tool side-effect goes through
the gateway adapter seam.
Discovery:
```
$ sed -n '1,20p' src/agent/policy/check-authorization-bypass.mjs   # mirrored structure
$ grep -n "export function scanFileForBypass" src/agent/policy/bypass-gate.ts
```
Migration boundary: pure scan source + CLI runner; scoped to src/agent, false-
positive-free.
Files: bypass-gate.ts, check-gateway-bypass.mjs, index.ts (edit), tests.
