# SPEC-068 Baseline — Policy & permission cache exclusions
No cache-eligibility rule existed. New: isCacheable — fail-closed; cacheable only if read-only intent + LOW/MED risk + no side effect + not permission-dependent. Uses G02 intent/risk. Additive.
