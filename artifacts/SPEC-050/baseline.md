# SPEC-050 Baseline — Context provenance & replay record
No replay record existed. New: buildReplayRecord + verifyReplay + hashContext — captures bundle provenance + content hash so any compiled prompt is reproducible/auditable. Uses node:crypto (local). Additive.
