# SPEC-077 — Test results
`npx vitest run src/agent/tools/registry`
```
 Test Files  5 passed (5)
      Tests  74 passed (74)     # 14+17+16+11+16
```
Owned-zone tsc: 0. Full-repo tsc: 0.

Cases → tests: parse valid/invalid (leading-zero rejected), compare, compatibility
(same-major≥ / older / cross-major / malformed fail-closed), bumpKind, transition
legality (forward-only, no-op illegal, lying-about-breakingness illegal),
resolveToolVersion vs live registry (compatible / incompatible-major / not-found),
every manifest parseable, boundary identity fail-closed + no-throw.
