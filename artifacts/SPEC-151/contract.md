# SPEC-151 Contract — Vendor-neutral model tier contract

Public surface (`@/agent/models`):

- `ModelTier` = `T0|T1|T2|T3|T4`; `TIER_DEFINITIONS` (usesLlm, input/output
  bounds, retries, timeout, requiresApproval, monotonic `rank`).
- `ModelInvocationPayload` / `ModelInvocationValue`; `ModelRequest` /
  `ModelResult` = canonical `ComponentRequest`/`ComponentResult` specialisations.
- `modelRequestSchema` (zod runtime validation); `MODEL_FABRIC_CONTRACT_VERSION`.
- `MODEL_REASON_CODES` — finite, append-only fabric reason codes.
- `TierModelRegistry` (tier → ordered `{provider, model}` bindings).
- `CostAuthorizationPort` (authorize/settle/release — INV-03 seam), `Clock`.
- `ProviderAdapter` interface + deterministic `createFakeAdapter` (no I/O).
- `TierHandler` interface + empty `defaultTierHandlers()` (tiers plug in 152→156).
- `invokeModel(request, deps)` — the single deterministic entry point.

No ambiguous boolean success; no untyped exception crosses the boundary; every
authoritative operation carries a full `ExecutionIdentity`. See `ARCHITECTURE.md`.
