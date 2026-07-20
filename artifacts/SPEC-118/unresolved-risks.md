# SPEC-118 Unresolved Risks
Critical unresolved risks: **0**.

Notes: revocation and consumption facts are inputs here (durable persistence + atomic single-consume enforcement belong to a later durable-queue group). The pure resolver guarantees that GIVEN a recorded consumption/revocation the grant is not usable — the storage layer must record consumption atomically to make single-use hold under concurrency.
