# SPEC-200 security proof

- **Fail-closed (INV-05)**: missing identity ⇒ DENIED/MISSING_TENANT; malformed ⇒ FAILED_FINAL/MALFORMED_INPUT; a missing or failed required gate, an incomplete spec set, a non-PASS verdict, a missing proof artifact, an unsatisfied or evidence-free checklist item each ⇒ DENIED. Tests assert every branch.
- **No manual override**: neither the core nor the runner has any input that converts missing proof into PASS — the only path to `certified: true` is every executable gate passing (constitution rule 10 / P0-8 required correction).
- **Tamper evidence**: `digest` is sha256 over canonical key-sorted evidence; any change to gate results, spec verdicts or checklist flips the digest.
- **Bounded input (INV-07)**: zod caps — 50 gate steps, 1000 spec proofs, 200 checklist items, string length caps; oversized input rejected before evaluation.
- **No secret leakage**: evidence contains ids/verdicts/filenames only.
