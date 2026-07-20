# SPEC-100 — Baseline (tool-selection & result-size regression gate)
Parent: SPEC-099 (`9ee5210b`). Owned zones: selection, results.

Each firewall facet (091–099) checks itself, but nothing exercises the WHOLE
firewall end-to-end and certifies every bound + no-leak invariant together.

Discovery:
```
$ grep -rn "evaluateFirewallGate\|regression" src/agent/tools/results  # none before this spec
```
Migration boundary: a fail-closed gate running sample selection + result pipelines
and asserting all 8 invariants.
Files: results/regression-gate.ts, tests, index.ts update; + a bound fix in
model-view.ts (see test-results).
