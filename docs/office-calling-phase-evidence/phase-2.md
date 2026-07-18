# Office Calling Phase 2 Verification

## Verdict

**PHASE 2: ENGINEERING PASS / DEVICE DEFERRED**

- Audited implementation SHA: `16f7a6349713b8d56ffa83bd2299bc3b0f0a5dc5`
- Branch: `agent/office-calling-whatsapp`
- Verifier: Codex hard gate
- Timestamp: 2026-07-17 23:52 Asia/Dhaka
- Physical iPhone/Android matrix: deliberately deferred to Phase 8 by the owner-approved fixed execution goal.

## Scope and delivery truth

- Processes the transactionally-created ring/cancel outbox with atomic claim, stale-lock recovery, bounded exponential retry and terminal `DEAD` status.
- A call with no eligible device or permanently rejected providers is server-ended as `PUSH_UNREACHABLE`; transient provider failure remains retryable and never claims ringing success.
- Provider evidence stores bounded status categories, latency and provider message IDs, never credentials, plaintext provider tokens or raw response bodies.
- Replaces canonical-call direct/best-effort sends with the durable outbox; the old direct path remains only behind the flag-off legacy flow.
- Adds an authenticated, business/user-bound native device registry with AES-256-GCM token encryption, stable token hashes, installation rotation, invalidation and user-scoped logout/account switching.
- Separates APNs sandbox/production delivery, uses immediate-or-drop `apns-expiration=0`, and invalidates permanent APNs/FCM rejections.
- Adds direct high-priority data FCM registration/receive on Android. The receiver rejects malformed, expired and late ring payloads, then requires an authenticated canonical `RINGING`/incoming/channel match before showing the call.
- Cancellation never uses a canonical VoIP push. Android receives direct FCM cancel; iOS uses regular notification/live reconciliation fallback.
- Adds owner diagnostics for encrypted registry configuration, provider readiness, registered device counts, outbox status and delivery alerts.

## Changed surfaces

- Prisma: additive installation identity migration and composite installation/provider uniqueness.
- Server: encrypted registry, register/logout API, APNs/FCM normalized payload/results, outbox dispatcher, cron processing, diagnostics and canonical legacy isolation.
- iOS: stable installation identity, build-derived APNs environment/build metadata, token rotation upload and invalidation logout.
- Android: Firebase Messaging dependency/service, launch/token-refresh registration, stable installation identity, canonical fetch-before-ring, expiry/late-push rejection and embedded build SHA.

## Automated hard gates

| Gate | Result |
|---|---|
| Focused auth/domain/observability/device/outbox suite | PASS — 5 files, 35 tests |
| No-device/permanent-reject delivery truth | PASS — `DEAD` + `PUSH_UNREACHABLE` |
| Transient retry/backoff | PASS — no false terminal transition |
| Atomic competing worker claim | PASS — losing worker does not dispatch |
| Late/expired ring | PASS — no push; canonical `MISSED` |
| APNs sandbox/production separation | PASS — separate provider calls |
| Permanent FCM rejection/invalidation | PASS |
| Canonical cancel never sends VoIP | PASS |
| Encrypted-at-rest token round trip/no plaintext storage | PASS |
| Token rotation/shared-device user-scoped logout | PASS |
| `npm run type-check` | PASS |
| `prisma validate` | PASS |
| `npm run lint` | PASS with repository pre-existing warnings only; no Phase 2 error |
| Android `:app:compileDebugKotlin` | PASS — 159 tasks, `BUILD SUCCESSFUL` |
| iOS full simulator workspace build, both architectures | PASS — `** BUILD SUCCEEDED **` |
| Full `npm run build` | PASS — 373 static pages; only existing OpenTelemetry/Sentry dynamic-import warnings |
| `git diff --check` | PASS |

## Deployed migration and build proof

- Preview: `https://alma-4mh4qhpcd-maruf-s-projects2.vercel.app`
- Vercel deployment: `dpl_HPr5fjbJuDhXXnS5w1nVqGU5wUS1`, status `Ready`.
- Final build log cloned branch commit `16f7a63`; Sentry release recorded full SHA `16f7a6349713b8d56ffa83bd2299bc3b0f0a5dc5`.
- The preceding Phase 2 deployment at `758031f` applied migration `20260919143000_office_call_device_identity`; the final exact-SHA deployment found 145 migrations and reported no pending migrations / migrations up to date.
- Final preview build and deployment completed successfully at 2026-07-17 23:47 Asia/Dhaka.

## Negative/security and privacy evidence

- Unauthenticated native registration `POST` returned HTTP `401` and `{"error":"unauthorized"}`.
- Unauthenticated installation logout `DELETE` returned HTTP `401` and `{"error":"unauthorized"}`.
- Auth tests reject unauthenticated, cross-business owner, former staff and non-member identities.
- Registry logout deletion is constrained by the authenticated `userId + installationId`; a shared phone cannot delete another account's binding by installation ID alone.
- Diagnostics and delivery events expose aggregate status/message IDs only. A source/output scan confirms plaintext device tokens are not returned or written to evidence.
- Invalid ciphertext is fail-closed and excluded from delivery.

## Physical and provider boundary

APNs/FCM provider delivery, Doze, killed/locked/background, notification-denied and shared-phone runtime rows are `DEVICE DEFERRED`. Phase 8 must run those on signed builds and attach call IDs, provider responses, device logs and video. This engineering PASS does not authorize release or the “fully WhatsApp-like” claim.

## Known non-blocking boundary

Phase 2 supplies durable wake delivery but native process-level call ownership, deterministic CallKit lifecycle/reconciliation, reconnect/audio-route policy and navigation persistence belong to Phases 3 and 4. Canonical sessions remain feature-flagged until those phases pass.
