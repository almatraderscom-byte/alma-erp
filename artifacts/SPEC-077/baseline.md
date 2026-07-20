# SPEC-077 — Baseline (tool versioning)

Parent: SPEC-076 (`bfa585b0`). Owned zones: registry, manifests.

Today tools have NO version. The head calls a tool by name; there is no contract
version, no compatibility check, no notion of a breaking change. The manifest
schema (SPEC-072) added a `version` field but no logic operated on it.

Discovery:
```
$ grep -rn "version" src/agent/tools/registry.ts src/agent/tools/tool-contract.ts | grep -vi "contractVersion\|COMPONENT" | head
# no per-tool semver logic
```

Migration boundary: strict semver parse/compare, SAME-MAJOR compatibility, and
forward-only transition legality with truthful breakingness, resolving against
the live manifest registry.

Files expected: `versioning.ts`, tests, `index.ts` update.
