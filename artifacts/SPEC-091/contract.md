# SPEC-091 — Contract (retrieval.ts, v1.0.0)
- `retrieveByDomain(domain): string[]` — sorted tools of one G08 domain.
- `retrieveForIntent({intentKey?|intentClass?|domain?, actor, requireAvailable?}):
  RetrievalResult{domains[], toolNames[], consideredCapabilities, resolved}` —
  unions the tools of every G09-resolved (permission/health-filtered) capability.
- `isRetrievableTool(name)`, `knownDomains()`.
- Boundary `retrieveTools(raw): ComponentResult<RetrievalResult>` — intent →
  COMPLETED/DENIED (fail-closed), direct domain → COMPLETED/FAILED_FINAL;
  identity-enforced; never throws; never returns the full surface as a fallback.
