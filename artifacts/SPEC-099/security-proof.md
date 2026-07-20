# SPEC-099 — Security proof
Every emitted result is traceable to its evidence record and the originating
identity (tenant + correlation); the boundary FAILS CLOSED
(UNKNOWN_OUTCOME) rather than emit an un-traceable result. The provenance carries
IDs only, not payloads (INV-07 preserved). Identity enforced; never throws. Secret
scan: none. PASS.
