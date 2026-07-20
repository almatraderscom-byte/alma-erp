# SPEC-062 Baseline — Provider prompt-cache adapter
No prompt-cache adapter existed. New: PromptCacheAdapter seam + InMemoryPromptCacheAdapter (deterministic fake). Real provider caching plugs in later; no real call here (INV-01). Additive.
