# SPEC-014 Baseline — Structured task envelope
No canonical hand-off shape existed between admission and the downstream path.
This spec adds `TaskEnvelope` (the pinned G02→G04/G05 interface) + builder +
zod schema. Depends on normalize/fast-path. Additive, zero cost.
