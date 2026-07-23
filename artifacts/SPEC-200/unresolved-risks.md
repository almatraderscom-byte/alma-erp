# SPEC-200 unresolved risks

- The machine-verified checklist covers the gates that exist today (freeze baseline, spec evidence, three bypass gates). Audit exit gates that still lack an executable check — universal Cost-Governor interception (P0-2), atomic workflow state+event commit in the PRODUCTION store (P0-6), runtime trace coverage of the full spine (P0-1), capacity SLOs (P0-7) — are deliberately NOT asserted by certification; they must be added as new checklist rows with executable gates as the production cutover proceeds. Certification therefore proves "architecture evidence complete + no static bypass", not "enterprise production cutover complete".
- `check-ownership.mjs --owner G01` passes trivially outside a spec session (empty diff scope); its value is CI-side on PRs.
- The runner shells out to vitest/tsc; a broken local toolchain surfaces as FAIL (fail-closed, but can mask the true cause — the per-step output lines disambiguate).
- No critical unresolved risks for the certification boundary itself. 0 blockers.
