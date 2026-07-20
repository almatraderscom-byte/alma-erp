# G16 — Model Fabric and Provider Adapters (group architecture record)

Owned zones: `src/agent/models`, `src/agent/providers/runtime`.
Prerequisites consumed: G01 (`@/agent/contracts`), G03 (`@/agent/finops`,
`@/agent/providers/pricing`), G05 (context, upstream of the bounded prompt view).

## Public contract

The fabric is the **single entry point for every model call**:

```ts
invokeModel(request: ComponentRequest<ModelInvocationPayload>, deps): Promise<ComponentResult<ModelInvocationValue>>
```

- Callers route by **tier** (`T0..T4`), never by a vendor model id.
- `ModelInvocationValue` carries the resolved `{provider, model}`, `usage`
  (finops `TokenUsage`), `finishReason`, `authorizationId`, `attempts`, and a
  `deterministic` flag (true only for the T0 path).
- Failures are the canonical typed `ComponentFailure` — finite reason codes
  (`MODEL_REASON_CODES` + canonical `REASON_CODES`), never a thrown provider
  error, never an ambiguous boolean.

### Vendor-neutral tiers

| Tier | Class | Uses LLM | Default allocation (tunable) |
| --- | --- | --- | --- |
| T0 | deterministic | no | none — pure code (INV-01) |
| T1 | classifier / extractor | yes | `or-deepseek-v4-flash` → `gemini-3.1-pro` |
| T2 | cheap specialist | yes | `or-deepseek-v4-flash` (ops) / `or-qwen3-max` (cs) |
| T3 | standard reasoner | yes | `gemini-3.1-pro` → `or-qwen3-max` |
| T4 | frontier escalation | yes | `claude-opus-4-8` (approval + daily cap) |

Tier is an invariant boundary: **the fabric never silently promotes a request to
a stronger/costlier tier**. Escalation is an explicit, caller-initiated new
request. Cost/capability rank is strictly increasing T0→T4.

## Data ownership

- The fabric owns tier routing, cost pre-authorization ordering, output bounding
  and outcome mapping. It owns **no** persistent state.
- Pricing/token estimation is owned by G03 (`@/agent/finops`), consumed read-only.
- The model receives a **bounded prompt view** only (INV-07); full payloads live
  in evidence storage upstream. Evidence ids are opaque correlation strings.

## Failure behaviour

- Missing identity/tenant/contract-version/oversized-input → `FAILED_FINAL`
  (fail closed) **before** any provider call or cost authorization.
- No cost authorization port, or a non-`ALLOWED` authorization → the provider is
  **never** called (INV-03). Budget deny → `BUDGET_EXCEEDED`.
- Provider `TIMEOUT`/`RETRYABLE` → `RETRYABLE` (reservation released).
  `FINAL` → `FAILED_FINAL` (released). `UNKNOWN` → `UNKNOWN_OUTCOME` — handed to
  reconciliation, **never blind-retried** (INV-06).
- Output beyond the tier ceiling → `FAILED_FINAL` but the real spend is still
  settled (accurate accounting).

## Cost behaviour

- Zero model calls are made by this group's code paths in tests — the only
  adapter is the deterministic FAKE. Estimation uses the G03 heuristic estimator.
- Every provider call is bracketed by `cost.authorize` (worst-case reserve) →
  `cost.settle` (actual) / `cost.release` (no spend). Real binding to the G04
  Cost Governor is a documented seam (`CostAuthorizationPort`).

## Security boundary

- One-way dependency intact: ERP (`src/app`, `src/lib`) must not import the
  fabric (forbidden-import gate; 0 new violations).
- No secrets, no API keys, no network calls anywhere in the owned zones.
- Frozen Hermes (`src/app/api/agent`), live `prisma/schema.prisma` and existing
  `src/agent/lib/models` are untouched.

## Feature modes (migration ladder)

`off → shadow → warn → enforce → rollback` per the G01 feature-flag contract.
The fabric is **additive and off by default**: legacy `src/agent/lib/models`
stays authoritative. Shadow/enforce binding of the fabric into the real head is a
G17 concern (Measured Routing and Head Model Isolation) — a documented seam here.

## Operational runbook

- Enable per tier by registering the tier handler and flipping the fabric flag to
  `shadow` (compare) then `enforce`.
- Provider allocation is tuned in `registry.ts` (`DEFAULT_TIER_MODELS`) — no code
  change to the fabric.

## Rollback command

Every spec is a single additive commit importing nothing from ERP; revert
restores the exact parent tree:

```
git revert --no-edit <SPEC commit>
```

## Unresolved risks

- Real provider adapters + real Cost Governor binding are seams, not wired here
  (by design — INV forbids real provider calls in this group).
- `UNKNOWN_OUTCOME` releases the reservation in the deterministic model; a later
  reconciliation component (post-G16) owns true unknown-spend settlement.
