# SPEC-071 — Changed files

All within owned zone `src/agent/tools/registry` + the spec proof dir. No file
outside the owned zones is modified (verified: `git status` shows only
`src/agent/tools/registry/` and `artifacts/SPEC-071/`).

```
src/agent/tools/registry/inventory.schema.ts        (new)  zod + TS row contract
src/agent/tools/registry/inventory.data.ts          (new, GENERATED) 326-row snapshot
src/agent/tools/registry/inventory.ts               (new)  runtime API + boundary
src/agent/tools/registry/index.ts                   (new)  barrel
src/agent/tools/registry/scripts/build-inventory.ts (new)  dev-time generator
src/agent/tools/registry/__tests__/inventory.test.ts(new)  14 tests
artifacts/SPEC-071/*.md                                    proof
```

Ownership-zone check (G01 `resolveOwner`): every path resolves to owner `agent`
(prefix `src/agent`) or `G01`/artifacts (`artifacts`). No `integrationOnly`
choke point (`prisma/schema.prisma`, `package.json`, `.github`) touched.
