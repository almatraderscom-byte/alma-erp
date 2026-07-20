# SPEC-156 Contract — Frontier escalation T4 tier
- `createT4Handler({ approvals?, dailyCap? })` registered as `T4`; default
  verifier rejects all + zero cap → fail-closed `NEEDS_APPROVAL`.
- Gate 1: valid `approvalToken` required (verified against `identity.actorId`);
  missing/invalid → `NEEDS_APPROVAL` (`MODEL_FRONTIER_APPROVAL_REQUIRED`).
- Gate 2: per-actor per-day attempt cap (`createInMemoryDailyCap`); exceeding →
  `DENIED` (`MODEL_FRONTIER_DAILY_CAP_EXCEEDED`); day derived from injected clock.
- The fabric never auto-escalates into T4 (proven: T3 request stays T3).
- `TierPrepareContext` gains `identity` (fabric passes it) — additive.
