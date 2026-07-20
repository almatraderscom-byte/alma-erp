# SPEC-151 Unresolved Risks

1. **Real provider adapters are a seam, not wired** (by design — INV forbids real
   provider calls in this group). Production Google/OpenRouter/Anthropic adapters
   implement `ProviderAdapter` outside this group; conformance is gated by SPEC-160.
2. **Real Cost Governor binding is a seam.** The fabric depends on
   `CostAuthorizationPort`; the concrete G04 governor binding lands with routing
   (G17). Fail-closed already holds (no port / deny → no provider call).
3. **UNKNOWN_OUTCOME cost handling:** the deterministic model releases the
   reservation; true unknown-spend reconciliation is a post-G16 component.

No unresolved **critical** risks. Count: 0.
