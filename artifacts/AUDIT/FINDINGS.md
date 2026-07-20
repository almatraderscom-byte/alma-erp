# Adversarial Read-Only Audit — Wave 1 Integrated Agent Code

**Branch audited:** `aios/integration-wave` (G01–G08 + G16 merged)
**Scope:** `src/agent/**` — contracts, control-plane/{admission,cost}, finops, budgets,
context, prompts, memory, cache, tools, models, providers.
**Method:** 4 parallel deep-read passes (cost/money, cross-tenant/cache, determinism,
tools-firewall/models) + auditor re-verification of every top finding against source.
**No source was modified.**

## Live-vs-latent note (affects severity)
Grep confirms much of this code is **integrated but not yet wired to a live caller**:
`admit()`, the cache classes, `SessionStateStore`, `ApprovalStore`, `reconcile()`,
`InMemoryCostLedger`, and the whole `models/` fabric appear only in their own definitions
+ `__tests__`. The `models` cost path IS wired end-to-end (`cost-port.ts` → `fabric.ts`),
and the `tools/` guard path (`runRegisteredTool`) is live. Reachability is flagged per
finding. "Latent" ≠ "not a bug": these are defects that fire the moment the documented
seam is wired, and several contradict a spec's own stated guarantee.

## Determinism (INV-01)
**Clean in the authoritative core.** Time/randomness are injected everywhere
(`nowMs`/`Clock`/`NowFn`); ids/hashes derive from caller seeds; the only ambient
`Date.now()` is the documented `systemClock` seam (`models/ports.ts:18`) with a
`fixedClock` replay twin. `tools/*` wall-clock/`fetch` are legitimate effect edges, not
folded into any cache key/provenance hash. No INV-01 violation found in scope.
(Scope gap: `src/agent/lib/policy/*` and `lib/effects/*` — the live permission/effect
kernel `tools/registry.ts` delegates to — were outside the primary sweep; a follow-up
INV-01 pass there is recommended, esp. capability-token minting and effect-id/idempotency
derivation.)

---

## Severity summary

| # | Severity | Reach | Finding |
|---|----------|-------|---------|
| 1 | HIGH | live (models) | Budget `commit()` clamp silently swallows real overspend; worst-case reservation is not a true upper bound (reasoning tokens uncapped) |
| 2 | HIGH | latent (failover unwired) | Failover breaks cost authorization + capability gating — authorize/price/gate computed for the PRIMARY, but a different candidate serves the call |
| 3 | HIGH | latent (approval store unwired) | `ApprovalStore` has no tenant/actor authorization — any caller can approve/read any pending money/destructive action by id |
| 4 | MED-HIGH | latent | `SessionStateStore` unscoped by tenant — cross-tenant read & clobber of session variables via a caller-suppliable `correlationId` |
| 5 | MED-HIGH | live (gateway API) | `admit()` enforces no mandatory pipeline — `admit(raw, [])` returns `admitted:true` with zero security stages |
| 6 | MED | latent | SPEC-068 cache-exclusions (`isCacheable`) and SPEC-069 isolation guard (`assertKeyTenant`) are wired into **no** caller — caches enforce neither |
| 7 | MED | live (models) | `UNKNOWN` provider outcome **releases** the cost reservation — possibly-charged spend treated as free, no reconciliation |
| 8 | MED | live (admission) | `dedup` fails **open** when the `normalized` annotation is absent — replay gate silently passes |
| 9 | MED | latent | Exactly-once/idempotency key omits actor + businessId (doc says otherwise); collapses to `'global'` scope → cross-business effect collapse |
| 10 | LOW | latent | `tenantOfKey` splits on `:` — a tenantId containing `:` is mis-attributed and can satisfy the isolation guard for a different tenant |
| 11 | LOW | latent | Malformed `per_mtok` price (missing rates) → worst-case 0 → `reserve(0)` accepted even on an exhausted budget → budget bypass |
| 12 | LOW | latent | `reconcile()` never flags an `OVER` variance for follow-up — buries the overspend signal from #1 |
| 13 | LOW | note | `guardResourceAccess` business check is not fail-closed when either side's `businessId` is absent |

---

## HIGH

### 1. Budget `commit()` clamp silently swallows real overspend
**Files:** `src/agent/budgets/budget.ts:111`; trigger `src/agent/models/cost-port.ts:44-48`, `fabric.ts:228,241`

`commit()` clamps actual spend down to the reserved worst-case:
```ts
const actual = Math.min(Math.max(0, Math.round(actualNanoUsd)), reserved);
b.spent += actual;
```
The whole model assumes the reservation is a *true upper bound*. But the live worst-case
bound is not: `cost-port.ts:44` feeds `maxInputTokens: input.estInputTokens` (a
`heuristicTokenEstimator` `chars/4` **guess**, not a hard cap) and
`maxReasoningTokens: input.estMaxOutputTokens` (reasoning capped at the *output* ceiling).
The fabric's output-bound check (`fabric.ts:228`) only bounds `outputTokens`, never
`reasoningTokens`. Reasoning models (Gemini 3.1 Pro, Opus) routinely emit far more
reasoning than visible output, so actual > reserved, and `commit()` throws the excess away.

**Repro (integer nano-USD, Gemini rates from `pricing/registry.ts`):** reserve est
1000 in / 1000 out / 1000 reasoning → `2000 + 10000 + 10000 = 22,000` nano reserved.
Provider returns 1000 in / 1000 out / **50,000 reasoning** → true `2000 + 10000 + 500000 =
512,000` nano. `commit()` records `min(512000, 22000) = 22,000`; **490,000 nano of real
spend vanishes.** `spent + reserved ≤ limit` stays "healthy" while the real bill blows the
budget. The `overspend-gate` fuzz only ever settles `actual ≤ reserved`, so this path is
never exercised. **This is the headline defect: the clamp converts an estimate error into
a silent, unbounded accounting error instead of surfacing it** (see #12 — the `OVER`
signal that would catch it is discarded).

### 2. Failover breaks cost authorization AND capability gating (primary-only)
**Files:** `src/agent/models/fabric.ts:160-241`, `cost-port.ts:60-66`, `attempt-runner.ts:60-90`

Cost authorization (`fabric.ts:175`), price capture (`cost-port.ts:34`), the capability
gate (`fabric.ts:161-165`), and settle (`fabric.ts:241`) are all computed for the
**primary** binding (`constraints.provider/model`). But when `deps.attemptRunner` is a
failover runner, `registry.candidates(tier)` is iterated and a **different** candidate can
serve the call (`servedProvider/servedModel`, `fabric.ts:216-217`). Nothing
re-authorizes, re-prices, or re-gates the served model. `CostAuthorizationPort.settle` has
no provider/model param, so `cost-port.ts:63` prices the served model's tokens at the
**primary's** stored price.

**Repro A (cost, T1):** candidates `openrouter/or-deepseek-v4-flash` (output $1.2/Mtok) →
`google/gemini-3.1-pro` (output **$10/Mtok**). DeepSeek returns `TIMEOUT` → Gemini serves.
Reservation was sized at DeepSeek worst-case; Gemini's real spend is booked at DeepSeek
rates and then clamped by #1. The hard cost governor's ceiling is defeated for the call.
(Existing `failover.test.ts` only tests **T3**, where failover is *cheaper* — Qwen $6 <
Gemini $10 — and `createFakeCostPort` never checks the settled price/model. `cost.settled`
length 1 is a weaker assertion than "settled at the served model's price." No T1-failover
test exists → costlier-on-failover direction untested.)

**Repro B (capability, T3):** primary `gemini-3.1-pro` (`vision:true`), failover
`or-qwen3-max` (`vision:false`). Request `requiredCapabilities:['vision']` → gate passes on
gemini → gemini times out → **qwen serves a vision request it cannot do.** The gate's
stated "fails closed" property is violated. `capability-gate.test.ts` only tests the
primary path — no failover+capability test.

### 3. `ApprovalStore` has no tenant/actor authorization
**File:** `src/agent/memory/pending-approval.ts:38-62`

This is the state store for the money/destructive **approval gate**. Every method keys
purely by a **caller-supplied `id`**:
```ts
resolve(id, status, atMs) { const cur = this.items.get(id); ... }   // any caller can approve
isActionable(id) { return this.items.get(id)?.status === 'approved'; }
get(id) { ... }
```
The record stores `identity` but no read/mutate method ever checks it. `resolve` has no
authority check at all — nothing verifies the resolver is the owner or same-tenant.

**Repro:** Tenant A: `request('ap-9', {tenantId:'A'}, 'transfer 50000', 'HIGH', t)`.
Tenant B: `resolve('ap-9','approved',t)` → succeeds; `isActionable('ap-9') → true`. A
different tenant/actor approves A's money move. (Docstring defers enforcement to G12, but
the state store itself provides zero isolation and `resolve` zero authority.)

---

## MEDIUM-HIGH / MEDIUM

### 4. `SessionStateStore` unscoped by tenant
**File:** `src/agent/memory/session-state.ts:36-60`

`get/put/update` key only by `correlationId`, with no tenant check — unlike the sibling
stores (`semantic-store.ts:63`, `episodic.ts`, `transcript.ts` all filter by
`identity.tenantId`). `correlationId` **can be caller-supplied**
(`execution-identity.ts:29-30,48-49`), so two tenants using the same `correlationId`
collide.

**Repro:** A: `put({correlationId:'run-1', identity:{tenantId:'A'}, variables:{secret:'x'}})`.
B: `get('run-1')` → returns A's state incl. `variables.secret`; B's `put` with the same
`correlationId` silently clobbers A's session.

### 5. `admit()` enforces no mandatory pipeline
**File:** `src/agent/control-plane/admission/gateway.ts:74-101`

The docstring says "`stages` defaults to the registered admission pipeline," but the
signature has **no default** — the caller passes the array and the gateway validates
nothing about it. `admit(validRequest, [])` runs zero stages and returns
`{status:'COMPLETED', value:{admitted:true, stagesRun:[]}}` — no normalize, no risk
classification, no dedup/replay. The "single door" guarantee is only as strong as each
caller's stage list, and `registry.ts` (the only `admissionPipeline()` source) is on the
bypass-gate internal block-list, pushing external callers toward hand-built lists.
**Fix direction:** default `stages = admissionPipeline()` and/or assert required stage ids
before returning admitted.

### 6. Cache safety guards are wired into no caller
**Files:** `src/agent/cache/exclusions.ts`, `isolation-guard.ts`, `response-cache.ts:34`, `semantic-response-cache.ts:27`

`isCacheable()` (SPEC-068, correct fail-closed predicate) and `assertKeyTenant()`
(SPEC-069 isolation) are referenced **only by their own modules + tests** (grep-confirmed).
`InMemoryResponseCache.put()` and `SemanticResponseCache.put()` store whatever they're
handed — they never receive intent/risk/permission and never call `isCacheable`.
`ToolResultCache` self-enforces `ttlMs<=0`, showing the intended pattern the other two
lack. So the guarantee "a cache hit must never replay a DENIED/ALLOWED authorization or a
side-effect" rests on a check every call site must remember to perform.

**Repro:** `respCache.put({key: conversationCacheKey(id,'pfx','can I approve payment?'),
response:'ALLOWED'})` succeeds; a later identical request returns `ALLOWED` from cache with
no re-authorization. Nothing in the cache module rejected it. **Fix direction:** thread
`CacheEligibility` into `put()` and reject `!isCacheable(...)`; call `assertKeyTenant` on
every `get`.

### 7. `UNKNOWN` provider outcome releases the reservation
**File:** `src/agent/models/fabric.ts:222-224`

```ts
if (outcome.kind !== 'OK') { await deps.cost.release(auth.authorizationId); return mapProviderError(outcome); }
```
`UNKNOWN` means "we don't know whether the call succeeded and spent money." The fabric
**releases** the hold (records zero) and no `CostEvent{status:'UNKNOWN'}` is ever written —
`reconcile()`/`InMemoryCostLedger` are never called from this path. It avoids a blind
*retry* (good) but fails INV-06's other half: possibly-real spend is assumed free, not
reconciled. (This auditor's own G16 `SPEC-151/unresolved-risks.md` documented this as a
known risk; recording it here as a confirmed integrated-branch defect for completeness.)

### 8. `dedup` fails open when `normalized` is absent
**File:** `src/agent/control-plane/admission/dedup.ts:66-67`

```ts
const normalized = ctx.annotations.normalized as NormalizedRequest | undefined;
if (!normalized) return { ok: true, ctx };   // silently PASS, no replay check
```
The replay gate skips instead of failing closed. Latent in the standard registry order
(normalize is first), but combined with #5 (`admit` accepts arbitrary stages), a pipeline
with `dedupStage` but not `normalizeStage` gets **zero replay protection with no signal**.
Same fail-open pattern in `intent.ts`, `complexity.ts`, `planning.ts`, `risk.ts`.
**Fix direction:** for the replay gate specifically, missing `normalized` should be a typed
`FAILED_FINAL`, not a pass.

### 9. Exactly-once / idempotency key omits actor + businessId
**File:** `src/agent/lib/policy/capability-token.ts` (`buildIdempotencyKey`)

The comment claims the key includes actor, but the implementation hashes only
`tool:scope:inputHash`, where `scope = turnId ?? conversationId ?? 'global'`. `businessId`
is carried in the envelope but not in the key. When both `turnId` and `conversationId` are
absent, `scope` collapses to the literal `'global'`, so any two calls with the same
tool+payload across all businesses/actors produce the same exactly-once key — a latent
cross-business effect collapse in the Phase-53 effect engine. (Live impact UNCERTAIN — the
in-memory duplicate check only fires when `ctx.turnId` is set — but the spec-vs-code
mismatch and the cross-tenant collision for the effect engine are real. No test asserts
actor/business is in the key.)

---

## LOW / UNCERTAIN / NOTES

### 10. `tenantOfKey` `:`-split mis-attribution
**Files:** `src/agent/cache/conversation-key.ts:23-31`, `isolation-guard.ts:17-22`
Key = `cc:${tenantId}:${prefixKey}:${requestHash}`; `tenantOfKey` returns `parts[1]`.
`prefixKey`/`requestHash` are hex, so the only injection vector is a `:` in `tenantId`
(nothing in `executionIdentitySchema` forbids it — only `.min(1)`). For tenant `"a:b"` the
key is `cc:a:b:…` and `tenantOfKey` returns `"a"`, so a caller whose tenant is literally
`"a"` passes `assertKeyTenant` for `"a:b"`'s key. The guard should compare the caller's
full tenant, not a `:`-split prefix (or tenant ids must be charset-restricted). UNCERTAIN:
only reachable if tenant ids may contain `:`.

### 11. Malformed `per_mtok` price → worst-case 0 → budget bypass
**Files:** `src/agent/finops/cost-calc.ts:12-15`, `budgets/budget.ts:93-103`, `models/cost-port.ts:38-58`
`cost-port` fails closed only when `getPrice()` is `null`. A registry entry with
`unit:'per_mtok'` but **undefined** rate fields is non-null, and `perMTokCost` returns 0
for undefined rates → `estimateWorstCaseCost = 0`. `reserve(0)` is always accepted
(`spent + reserved + 0 > limit` is false even when `spent == limit`), the real call
proceeds, and settle clamps to the 0 reservation → **the model bypasses the budget
entirely and records nothing.** `validateRegistry()` catches the mis-seed but is not
enforced at authorize time. UNCERTAIN (needs a mis-seeded registry) but a real
defense-in-depth hole: authorize should assert a non-zero worst-case for a chargeable unit.

### 12. `reconcile()` never flags an `OVER` variance
**File:** `src/agent/finops/reconciliation.ts:35-43`
`needsReconciliation` returns true only for `status === 'UNKNOWN'`. `OVER` (actual >
estimate) is exactly the signal that the reservation was too low — the condition #1's clamp
buries — yet it triggers no follow-up. Latent (no prod caller) but discards the overspend
signal once wired.

### 13. `guardResourceAccess` business check not fail-closed
**File:** `src/agent/contracts/tenant-context.ts:29-31`
Business isolation is enforced only when **both** resource and caller carry a `businessId`;
either absent → check skipped. Tenant check is solid; the business dimension is not
fail-closed. Documented in the docstring, so likely by-design — flagged for completeness.

### Other minor (completeness)
- `cost-calc.ts:14` uses `Math.round` where the worst-case path wants `ceil` (sub-nano,
  immaterial).
- `cost-port.ts:44` omits `maxToolCalls` from the worst-case reservation — latent until a
  price sets `perToolCallNanoUsd`.
- `tools/tool-contract.ts` `validateToolInput` returns `{ok:true}` (fail-open) when a
  schema fails to compile (CI-guarded, bounded).
- Untrusted-content firewall (`lib/policy/action-policy.ts`) engages only if the caller
  tags `instructionOrigin:'external_content'`; correctness depends on every
  tool-result→tool-call path tagging origin (out of audited scope — recommend a targeted
  check).

---

## Recommended priority
Fix **#1 + #2** together (they share one root: cost authorization/gating is computed once
for the primary and never re-derived for the served model, and the clamp hides the
resulting shortfall) before failover or the real cost port is wired to production. Then
**#3/#4/#6** (tenant/permission isolation must be enforced at the store/cache choke point,
not left to callers) and **#5** (make the single door actually mandatory).
