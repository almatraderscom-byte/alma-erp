# SPEC-069 Baseline — Cross-tenant cache isolation
No isolation guard existed. New: assertKeyTenant/authorizedKeys — fail-closed; a cache key is readable only by its embedded tenant. Security capstone of the cache layer. Additive.
