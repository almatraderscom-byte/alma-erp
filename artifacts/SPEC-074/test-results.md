# SPEC-074 — Test results
`npx vitest run src/agent/tools/registry`
```
 Test Files  2 passed (2)
      Tests  31 passed (31)     # 14 inventory + 17 io-schema
```
Owned-zone tsc: 0. Full-repo tsc: 0. Determinism: regenerate → diff empty.

Cases → tests: full coverage (326 schemas resolve), strictenSchema, strict path
(valid / missing-required / unknown-field / bad-enum), permissive default path,
**unknown schema fails CLOSED**, bounded view (passthrough / secret-redaction /
truncation+evidence), boundary identity fail-closed + no-throw.
