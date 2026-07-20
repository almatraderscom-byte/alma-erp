# SPEC-147 security proof
- Secret containment (INV-07): element values dropped entirely; labels matching password/token/bearer/JWT/email/long-token patterns replaced with [REDACTED]; URL query+fragment stripped. Tests assert none of the secret payloads survive serialization.
- Bounded model view: element set capped, labels truncated, hard byte ceiling fails closed — limits both token cost and prompt-injection surface.
- Deterministic redaction: no RNG; identical input yields identical redacted output (replayable/auditable).
