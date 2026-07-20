# SPEC-087 — Test results
`npx vitest run src/agent/capabilities`
```
 Test Files  7 passed (7)
      Tests  78 passed (78)     # 15+11+9+13+9+9+12
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Cases → tests: availability fail-closed (healthy/degraded available; disabled/
kill-switch/unknown unavailable); transitions (degrade/disable/kill/restore; ok
keeps kill-switch); override store wins + clears; catalog integrity clean;
boundary isAvailable/transition + identity fail-closed + no-throw.
