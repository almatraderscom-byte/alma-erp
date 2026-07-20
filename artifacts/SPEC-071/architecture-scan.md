# SPEC-071 — Architecture scan

## Runtime import graph (owned zone)

```
$ grep -rhoE "from '[^']+'" src/agent/tools/registry/*.ts | sort | uniq -c
   2 from '@/agent/contracts'          # G01 contracts (allowed)
   4 from './inventory.schema'
   1 from './inventory.data'
   ... relative ...
   2 from 'zod'
```

Runtime files (`inventory.ts`, `inventory.data.ts`, `inventory.schema.ts`,
`index.ts`) import the monolith: **NONE** (verified). The only monolith import
lives in `scripts/build-inventory.ts` (dev-time codegen, never bundled/executed
at runtime).

## Direct model / provider / tool / DB call scan

```
$ grep -rnE "anthropic|openai|gemini|deepseek|qwen|fetch\(|axios|prisma|@/lib/|process.env" \
    src/agent/tools/registry/*.ts src/agent/tools/registry/scripts/*.ts | grep -v 'node:'
# only doc-comment mentions of the WORD "prisma"; no call sites
```

INV-01 (no LLM for deterministic work) holds: the module is pure data + zod.

## Forbidden-import direction (G01 invariants)

ERP (`src/app`, `src/lib`) → agent is the forbidden direction. The new files are
agent-side (`src/agent/**`). No ERP file imports the new registry. Existing
`src/app/api/assistant/*` imports resolve to the monolith `registry.ts` file
(bare specifier → file beats directory), not the new package.

## Ownership-zone diff check

`git status --porcelain` → only `src/agent/tools/registry/` and
`artifacts/SPEC-071/`. Both owned by this session (owner `agent` / `G01`
artifacts). No shared choke point touched.

## Bypass verdict

PASS — no runtime coupling to the monolith, no provider/DB/LLM call, no ERP→agent
import, no choke-point edit.
