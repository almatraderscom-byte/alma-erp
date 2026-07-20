# SPEC-083 — Test results
`npx vitest run src/agent/capabilities`
```
 Test Files  3 passed (3)
      Tests  35 passed (35)     # 15+11+9
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Key integration: catalog covers every G08 tool exactly once — coverage.totalTools
== routedTools == 326, uncovered=[], duplicated=[].
Cases → tests: every cap tool resolves; partition coverage; whole-set clean;
toolsForCapability/capabilitiesForTool; phantom tool → MISSING_TOOL; duplicate
routing + uncovered flagged; boundary identity fail-closed + no-throw.
