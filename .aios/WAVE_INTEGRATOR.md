# Wave Integrator Protocol

Use a separate clean worktree.

1. Read certifications for every group in the wave.
2. Reject any group without 10 individual PASS verdicts and a group PASS.
3. Merge one group at a time in dependency/numeric order.
4. Resolve central schema, package, generated-code and CI changes only here.
5. After each merge, run typecheck and targeted tests.
6. After the complete wave, run:
   - full typecheck
   - full unit/integration tests
   - migration validation
   - architecture bypass scans
   - tenant isolation tests
   - cost regression
   - security/prompt-injection suite available at that wave
   - rollback drill
7. Produce `artifacts/WAVE-X/INTEGRATION_CERTIFICATION.md`.
8. Do not begin the next wave unless verdict is PASS.
