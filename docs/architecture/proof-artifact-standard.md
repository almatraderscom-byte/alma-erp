# AI Change-Proof Artifact Standard (G01 / SPEC-009)

Source: `src/agent/contracts/proof-artifact.ts`. Gate:
`scripts/architecture/check-proof.mjs`. Realises INV-10 (executable proof, not
explanation).

## Required artifacts (every spec)
`baseline.md`, `contract.md`, `changed-files.md`, `test-results.md`,
`architecture-scan.md`, `cost-before-after.md`, `security-proof.md`,
`rollback-proof.md`, `unresolved-risks.md`, `final-verdict.md`.

`final-verdict.md` must contain `Verdict: PASS|PARTIAL|FAIL`. A spec advances the
Group Runner only when the dir is complete AND verdict is `PASS`
(`isAdvanceable`).

## Gate
`node scripts/architecture/check-proof.mjs --require-pass` fails if any
`artifacts/SPEC-XXX/` is incomplete or not PASS. Wired into the freeze gate
(SPEC-010) and the group certification.

Rollback: `git revert --no-edit <SPEC-009 commit>`.
