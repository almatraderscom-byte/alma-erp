# SPEC-071 — Baseline (current monolithic registry inventory)

Parent commit: `35920d4d`
Owned zones: `src/agent/tools/registry`, `src/agent/tools/manifests`

## Current implementation and aliases

The tool surface is assembled by a single monolith:

- `src/agent/tools/registry.ts` — **1041 lines**. Imports ~80 `*_TOOLS`
  arrays and re-exports the merged pools (`TOOLS`, `TRADING_TOOLS`,
  `PERSONAL_SAFE_TOOLS`, `STAFF_SAFE_TOOLS`), the executors
  (`executeTool`, `runRegisteredTool`), and the model-facing definitions
  (`TOOL_DEFINITIONS`). This is the "monolithic registry" the group decomposes.
- `src/agent/tools/tool-contract.ts` — tool contract V2 (types, error codes,
  ajv validation).
- `src/agent/tools/capability-classification.ts` — authored `domain/mode/risk`
  per tool (single source of truth for classification).
- `src/agent/tools/tool-groups.ts` — `TOOL_GROUPS` (14 head-facing routing groups).
- `src/agent/tools/capability-manifest.ts` — a joined view (pools + groups +
  classification). This is the closest existing artifact to a "manifest".
- `src/agent/tools/cs-registry.ts` — the customer-facing pool `CUSTOMER_SAFE_TOOLS`.

Exact discovery commands:

```
$ wc -l src/agent/tools/registry.ts
1041 src/agent/tools/registry.ts
$ ls src/agent/tools/*.ts | wc -l
78
$ grep -nE '^export ' src/agent/tools/registry.ts | wc -l   # 20 exported symbols
```

## Inventory measurement (exact)

A one-shot dev-time import of the monolith's authored metadata
(`TOOL_CLASSIFICATION` + `TOOL_GROUPS` + the five pools) yields:

```
total 326   classified 326   pooled 326
byMode { read: 178, stage: 61, write: 87 }
byRisk { low: 240, medium: 56, high: 30 }
groups base,content,cost,cs,diag,erp,finance,growth,personal,salah,staff,trading,vision,website
pools  customer,lifestyle,personal,staff,trading
domains (63): ads, advisor, alerts, analytics, appointments, approvals, artifacts,
  ask, autonomy, bills, brand, briefing, browser, calls, camera, campaign,
  competitor, content, core, cost, coworker, creative, cs, dates, diag,
  documents, erp, family, finance, gbp, growth, health, live_browser, location,
  marketing, memory, meta_ads, orchestrator, personal, plan, playbook, push,
  qc, reference, reminders, research, salah, seo, settings, simulate, skills,
  social, staff, studio, tasking, todo, trading, tryon, vision, wa, website,
  workbench, worktodo
```

## Callers and downstream dependencies

`@/agent/tools/registry` is imported by (representative):

```
$ grep -rnE "tools/registry" src/app src/lib
src/app/api/assistant/voice-call/erp-tool/route.ts: import { executeTool } ...
src/app/api/assistant/mcp/route.ts:                 import { TOOLS, type AgentTool } ...
src/app/api/assistant/internal/skill-import/route.ts: const { TOOLS } = await import(...)
```

plus `capability-manifest.ts`, `tool-groups.ts`, and the agent core loop.
The frozen legacy path `src/app/api/agent/*` (Hermes) is **not** touched.

## Direct provider / model / tool / database calls

The monolith handlers call prisma, embeddings, telegram, meta graph, etc.
directly. The **decomposed registry must not** — it is metadata only (INV-01).

## Current tests

`src/agent/tools/__tests__/` holds 23 test files incl.
`capability-manifest.test.ts` (classification completeness), `tool-pool-coverage`,
`tool-guard-coverage`. These stay green (SPEC edits are additive, new directory).

## Cost & latency evidence

Not applicable at runtime: the decomposed registry performs zero model/provider
calls. The only cost is a dev-time codegen import (`build-inventory.ts`), which
never runs in production. See `cost-before-after.md`.

## Tenant / permission / audit propagation

The monolith executor receives an `OwnerTurnAuthorization`; it does not carry a
full `ExecutionIdentity`. The new boundary (`queryInventory`) enforces the G01
`ExecutionIdentity` (tenant/actor/workflow/step/correlation) fail-closed.

## Likely bypass paths

- Importing the monolith at runtime from the new registry (would re-couple).
  Mitigated: runtime files import only `@/agent/contracts`, `zod`, and the
  committed snapshot; the monolith import lives **only** in the dev-time
  generator script.
- Name collision `registry.ts` (file) vs `registry/` (dir). Node/TS resolve the
  bare specifier `@/agent/tools/registry` to the **file**, so existing callers
  are unaffected (confirmed: full-repo `tsc` = 0 errors). New code imports the
  sub-path `@/agent/tools/registry/inventory`.

## Proposed migration boundary

`src/agent/tools/registry/` (new directory) hosts the decomposed, deterministic
registry. Data flows: monolith → (dev-time generator) → committed snapshot →
runtime registry. The monolith stays authoritative until SPEC-080's removal gate
certifies full coverage.

## Files expected to change (this spec)

- `src/agent/tools/registry/inventory.schema.ts` (new)
- `src/agent/tools/registry/inventory.data.ts` (new, generated)
- `src/agent/tools/registry/inventory.ts` (new)
- `src/agent/tools/registry/index.ts` (new)
- `src/agent/tools/registry/scripts/build-inventory.ts` (new)
- `src/agent/tools/registry/__tests__/inventory.test.ts` (new)
- `artifacts/SPEC-071/*` (proof)
