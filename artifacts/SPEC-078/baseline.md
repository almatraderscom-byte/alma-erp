# SPEC-078 — Baseline (tool deprecation and migration)

Parent: SPEC-077 (`f8049e8f`). Owned zones: registry, manifests.

Today there is NO deprecation lifecycle. Renamed/removed tools have historically
been handled ad-hoc (e.g. an alias in a handler); a removed tool name simply
becomes unknown_tool at call time with no migration hint. The manifest schema
(SPEC-072) added a `deprecation` record but no engine operated on it.

Discovery:
```
$ grep -rn "deprecat\|replacedBy\|alias" src/agent/tools/*.ts | grep -vi "eslint" | head
# no lifecycle engine
```

Migration boundary: a callability + migration-chain engine over
`status`+`deprecation`, fail-closed on removed tools and cycle-safe on chains.

Files expected: `deprecation.ts`, tests, `index.ts` update.
