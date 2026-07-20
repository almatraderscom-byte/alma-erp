# SPEC-146 security proof
- Anti-hallucination / anti-injection: `decideAction` refuses any click/type/read whose target is absent from the current perception (DENIED/TARGET_NOT_IN_PERCEPTION). A model that invents "Delete everything" cannot act because no such element is present.
- Bounded surface: plan (<=32 steps) and observation (<=64 elements) are size-capped; instruction/text bounded.
- Fail-closed: malformed plan/observation/cursor and missing target hint all deny.
