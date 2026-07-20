# SPEC-091 — Baseline (domain-first tool retrieval)
G10 base: `113c0d7d`. Owned zones: `src/agent/tools/selection`, `src/agent/tools/results`.

Today the head is handed tool sets by fixed TOOL_GROUPS; there is no permission-
scoped, intent-driven retrieval that narrows the 326-tool surface to just the
relevant domains before selection. G09 provides `resolveCapabilities` (intent +
permission + health filtered); G08 provides `manifestsForDomain`/`domains`.

Discovery:
```
$ grep -rn "resolveCapabilities" src/agent/capabilities/resolver.ts
$ grep -n "manifestsForDomain\|domains" src/agent/tools/manifests/loader.ts
$ ls src/agent/tools/selection   # did not exist
```
Migration boundary: `retrieveForIntent` (union of resolver-approved capabilities'
tools) + `retrieveByDomain`; fail-closed, never a full-surface fallback.
Files: selection/retrieval.ts, index.ts, tests.
