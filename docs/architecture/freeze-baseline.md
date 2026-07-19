# Architecture Freeze Baseline (G01 / SPEC-010)

The single command that certifies the frozen baseline:

```
node scripts/architecture/freeze-gate.mjs
```

It runs, and requires exit 0 from, every dimension:

| Step | Kind | Command |
| --- | --- | --- |
| contracts-typecheck | typecheck | `tsc --noEmit -p src/agent/contracts/tsconfig.json` |
| contracts-tests | test | `vitest run src/agent/contracts` |
| forbidden-imports | dependency | `check-forbidden-imports.mjs` (ratchet) |
| ownership | ownership | `check-ownership.mjs --owner G01` |
| adr-lint | adr | `check-adr.mjs` |
| proof-complete | proof | `check-proof.mjs --require-pass` |

Typed step registry + coverage assertion: `src/agent/contracts/freeze.ts`
(`FREEZE_GATE_STEPS`, `coversAllKinds`, `freezeHolds`). Barrel:
`src/agent/contracts/index.ts`.

Baseline status at freeze: **PASS** — see `artifacts/G01/GROUP_CERTIFICATION.md`.

Rollback: `git revert --no-edit <SPEC-010 commit>`.
