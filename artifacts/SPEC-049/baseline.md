# SPEC-049 Baseline — Context token allocator
No token allocator existed. New: allocate(bundles, maxTokens) fits context to budget, dropping low-priority bundles (memory->workflow_state->tool_schema->skill) first; never drops must-keeps (constitution/policy/request); OVERFLOW fail-closed. Uses G03 estimator. Additive.
