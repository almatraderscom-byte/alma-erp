# SPEC-200 rollback proof

- The certification core + runner + proof files are a purely additive change: reverting the SPEC-200 commit removes `src/agent/release/certification.ts`, its tests, the runner and `artifacts/SPEC-200/` with no runtime dependency left dangling (nothing imports the module yet outside its own tests; the runner is invoked only by CI/hand).
- The SPEC-141..150 verdict-format standardization is content-preserving (verdict semantics unchanged: PASS before in prose, PASS after in machine-readable form); reverting restores the prior wording only.
- The forbidden-import baseline addition can be reverted independently; the gate then simply reports those two known agent-cron edges again — no runtime behavior change (the checker is CI-only).
- Runtime rollback: not applicable — no production request path executes this module; certification gates releases, it does not serve traffic.
