# SPEC-001 Baseline — Architecture inventory and request-path map

## Discovery commands (exact)

```
$ git rev-parse HEAD            # branch base = clean main
$ node -v                        # v22.22.2
$ rg --files src | wc -l         # source file census
$ node scripts/architecture/inventory.mjs   # (this spec's tool)
```

## Current implementation and aliases

No prior "architecture inventory" or canonical component contract exists. The
repo has an agent module under `src/agent/**` (750 files) but no
`src/agent/contracts` zone, no `docs/architecture`, no `scripts/architecture`.

## Callers and downstream dependencies

- Legacy agent HTTP surface: `src/app/api/agent/**` (72 files) — **frozen**, not
  touched by this group (CLAUDE.md hard rule).
- New agent HTTP surface: `src/app/api/assistant/**` (258 files).
- Shared libs: `src/lib/**` (407 files) — importable by both ERP and agent.

## Direct provider / model / tool / database calls (live scan)

| Provider | Call-sites | | Provider | Call-sites |
| --- | --- | --- | --- | --- |
| anthropic | 20 | | facebook-graph | 6 |
| google-generative | 13 | | openai-whisper | 5 |
| openrouter | 9 | | twilio | 4 |
| telegram | 9 | | google-tts | 2 |

Database caller files: **704** (`prisma` / `$queryRaw` / `$executeRaw`).

## Current tests

Repo uses **vitest** (`vitest.config.ts`, `include: src/**/*.test.ts`). No test
existed for a component contract (none existed). Baseline `npm test` surface is
unrelated to the owned zones.

## Current cost and latency evidence

Not applicable to this spec. The deliverable (types + a static scanner + docs)
performs **zero** model calls and **zero** network I/O. Cost baseline = 0.

## Tenant / permission / audit propagation

No canonical `ExecutionIdentity` existed before this spec. This spec introduces
the frozen shape; propagation enforcement lands in SPEC-004/005.

## Likely bypass paths

- ERP code importing `src/agent/**` (violates one-way dependency). Scanned:
  0 occurrences (see `architecture-scan.md`). SPEC-002 makes this an executable
  gate.

## Proposed migration boundary

Additive only. New zones: `src/agent/contracts`, `scripts/architecture`,
`docs/architecture`. No existing file is modified. Nothing in production imports
the new module, so the change is inert until later groups adopt it.

## Files expected to change

- `src/agent/contracts/component.ts` (new)
- `src/agent/contracts/__tests__/component.test.ts` (new)
- `src/agent/contracts/tsconfig.json` (new, scoped typecheck)
- `scripts/architecture/_shared.mjs`, `scripts/architecture/inventory.mjs` (new)
- `docs/architecture/request-path-map.md`, `docs/architecture/inventory.json` (new)
- `artifacts/SPEC-001/**` (proof)
