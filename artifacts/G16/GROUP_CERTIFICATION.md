# G16 — GROUP CERTIFICATION

Group: G16 — Model Fabric and Provider Adapters
Branch: `aios/G16-model-fabric` (base = G01+G02+G03+G04+G05)

```
Group: G16
Specs: SPEC-151..SPEC-160
Individual PASS count: 10/10
Repository integration tests: PASS
Architecture scan: PASS
Cost regression: PASS
Security regression: PASS
Rollback drill: PASS
Unresolved critical risks: 0
Verdict: PASS
```

## What G16 built

The **vendor-neutral model fabric** — one typed entry point (`invokeModel`) that
routes every model call by *tier* (T0..T4), never by a hard-coded vendor model,
with cost pre-authorization, capability gating, timeout/quota controls, in-tier
failover, and an adapter conformance harness. Owned zones only:
`src/agent/models`, `src/agent/providers/runtime`.

| Spec | Deliverable |
| --- | --- |
| SPEC-151 | vendor-neutral tier contract + fabric + provider adapter interface + deterministic FAKE adapter |
| SPEC-152 | deterministic T0 path (no LLM call, no cost — INV-01) |
| SPEC-153 | classifier/extractor T1 tier (structured-only, bounded, closed-label) |
| SPEC-154 | cheap specialist T2 tier (closed role set; ops→DeepSeek, cs→Qwen) |
| SPEC-155 | standard reasoner T3 tier + **real** G04-governor-backed cost port (G03 pricing/estimator) |
| SPEC-156 | frontier escalation T4 tier (approval + per-actor daily cap, fail closed) |
| SPEC-157 | provider capability discovery (static registry + fabric gate) |
| SPEC-158 | provider timeout + quota controls (deterministic, clock-injected) |
| SPEC-159 | provider failover rules (in-tier only, never escalates a tier) |
| SPEC-160 | model adapter conformance harness (gates every adapter; catches violations) |

## Integration checkpoint

| Check | Result |
| --- | --- |
| Full repository typecheck | **PASS** (`tsc -p tsconfig.json` exit 0) |
| Scoped typecheck (both owned zones) | **PASS** (exit 0 each) |
| Owned-zone suite (`vitest run src/agent/models src/agent/providers/runtime`) | **PASS** (84/84, 15 files) |
| Full agent suite (`vitest run src/agent`) | **PASS** (2775/2775, 262 files) |
| Full repository suite (`vitest run`) | **PASS** (3099 passed, 1 pre-existing skip, 301 files) |
| Database migration validation | **PASS** (0 files touched under `prisma/`; no schema change) |
| Architecture bypass / forbidden-import gate | **PASS** (0 new violations; 101 baselined) |
| Tenant / identity isolation | **PASS** (fabric validates full `ExecutionIdentity`; missing tenant/actor fail closed before any provider call) |
| Security regression (secrets / network / provider call) | **PASS** (NONE in owned zones — only the deterministic FAKE adapter) |
| Cost vs baseline | **PASS** (0 real model calls; INV-01/INV-03 upheld; cost is pure nano-USD arithmetic over the G03 registry) |
| Group rollback drill (revert whole G16 range) | **PASS** (base tree `6fada4b8…` restored exactly) |

## Scope discipline

141 files changed, **4280 insertions, 0 modifications, 0 deletions** of any
pre-existing file; every change within `src/agent/models`,
`src/agent/providers/runtime` and `artifacts/`. Frozen Hermes
(`src/app/api/agent`), live `prisma/schema.prisma` and legacy
`src/agent/lib/models`: **0 touched**.

## Critical-risk note (per group objective)

This group is about provider adapters, and the standing instruction was: make **no
real network/provider call** in code or tests. Verified:

- The only adapter shipped is the deterministic FAKE (`fake-adapter.ts`); the
  `ProviderAdapter` interface is the seam. No `fetch`/SDK/`http`/`net`/`dns` and
  no API keys exist anywhere in the owned zones.
- Every model call is pre-authorized by the Cost Governor (INV-03); a missing
  port or a denial means the provider is never invoked.
- Unknown provider outcomes → `UNKNOWN_OUTCOME` (reconciliation), never blind
  retry (INV-06). The fabric never silently escalates to a stronger/costlier tier.

Real SDK adapters, a durable budget store, an approval authority, and the
head-model binding are documented seams (owned by G17 and later) — deliberately
NOT wired here.

## Verdict

**PASS** — 10/10 specs PASS, all integration gates green, 0 unresolved critical
risks. G16 is certified. No PR to main; no other group started.
