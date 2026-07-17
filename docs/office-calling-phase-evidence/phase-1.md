# Office Calling Phase 1 Verification

## Verdict

**PHASE 1: ENGINEERING PASS / DEVICE DEFERRED**

- Audited implementation SHA: `2835f7c6b9de2f8c0b7831992938bafd31793616`
- Branch: `agent/office-calling-whatsapp`
- Verifier: Codex hard gate
- Timestamp: 2026-07-17 23:15 Asia/Dhaka
- Physical iPhone/Android matrix: deliberately deferred to Phase 8 by the owner-approved fixed execution goal.

## Scope and evidence

- Added canonical `OfficeCallSession`, `OfficeCallLeg`, `OfficeCallEvent`, `OfficeCallOutbox`, `OfficeCallDevice`, and transactional participant locks.
- Added additive migration `20260919130000_office_call_domain`.
- Added strict actor/state/terminal-reason transition policy, optimistic version CAS, Serializable create retry, idempotent create, one-active-call locks, server ring/max-duration reconciliation, and durable terminal cancel events.
- Bound canonical Agora tokens to the exact call, business, participant, channel and stable non-zero participant UID; the same endpoint supports audited renewal.
- Added exact business membership enforcement and removed global earliest-admin owner selection.
- Kept the legacy call projection behind `OFFICE_CALL_SESSIONS_ENABLED`; canonical writes remain additive.

## Automated hard gates

| Gate | Result |
|---|---|
| Focused auth/domain/observability suite, run 1 | PASS — 3 files, 23 tests |
| Focused auth/domain/observability suite, run 2 | PASS — 3 files, 23 tests |
| Illegal transition table | PASS — all forbidden edges enumerated |
| Concurrent terminal CAS | PASS — one winner, one version conflict |
| Concurrent two-device answer CAS | PASS — one winner, one version conflict |
| Timeout vs late answer | PASS — server `MISSED` wins |
| Duplicate create idempotency | PASS — original call returned, no second transaction |
| Participant-lock collision | PASS — deterministic `busy` |
| Serializable conflict retry | PASS — two `P2034` conflicts then success |
| Cross-business/former-staff/unauthenticated auth | PASS |
| `npm run type-check` | PASS |
| Changed-file Next ESLint | PASS — no warnings/errors |
| `prisma validate` and `prisma generate` | PASS |
| Prisma empty-to-schema SQL generation | PASS |
| `git diff --check` | PASS |
| Full `npm run build` | PASS; only pre-existing OpenTelemetry/Sentry dynamic dependency warnings |

## Deployed migration and build proof

- Preview: `https://alma-3spe2fkq1-maruf-s-projects2.vercel.app`
- Vercel deployment: `dpl_HuigLasE5HH4VLD3K8EZiz1MEcnG`, status `Ready`.
- Build log cloned branch commit `2835f7c` and Sentry release recorded the full audited SHA.
- Vercel migration log: applied `20260919130000_office_call_domain`; Prisma reported all migrations successfully applied.
- Preview deployment completed successfully at 2026-07-17 23:10 Asia/Dhaka.

## Negative preview security proof

- Unauthenticated canonical call read returned HTTP `401` and `{"error":"Unauthorized"}`.
- Unauthenticated Agora token request for a syntactically valid call channel returned HTTP `401` and `{"error":"Unauthorized"}`.
- Unit tests additionally prove exact owner business membership, active-staff business scope, non-participant denial, and actor-specific transition denial.

## DB/event and physical evidence boundary

No synthetic production call was created merely to manufacture a DB screenshot, and no provider token or secret appears in this record. The deployed migration is proven against the release database; canonical row/event correlation and signed-device push/join/end evidence remain `DEVICE DEFERRED` until the feature flag and Phase 2–7 clients are ready. Phase 8 must attach real call IDs, session/leg/outbox/event rows, provider results, device logs and videos before release.

## Known non-blocking boundary

Phase 1 persists the delivery outbox atomically but does not process it; retry/backoff, encrypted device registration, provider classification and `push_unreachable` delivery truth belong to Phase 2. Canonical sessions must remain feature-flagged until that phase passes.
