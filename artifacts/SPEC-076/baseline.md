# SPEC-076 — Baseline (tool ownership metadata)

Parent: SPEC-075 (`752c4974`). Owned zones: registry, manifests.

Today there is NO per-tool ownership binding. Ownership exists only at the repo
level (`src/agent/contracts/ownership.ts`, G01) via path prefixes; tools are not
tied to a zone/team, so "who owns this tool" is not machine-checkable.

Discovery:
```
$ grep -n "OWNERSHIP_ZONES\|resolveOwner" src/agent/contracts/ownership.ts
$ grep -rn "owner\|team\|CODEOWNERS" src/agent/tools/*.ts | grep -vi "business owner" | head
# no tool→owner binding exists
```

Migration boundary: bind each manifest's `ownership {team, zonePrefix}` to a real
G01 zone via `resolveOwner`, enforce agent-side + team agreement fail-closed, and
emit a CODEOWNERS proposal for tool domains.

Files expected: `ownership-metadata.ts`, tests, `index.ts` update.
