# Office Calling Phase 7 Evidence — Resilience, Security and Quality

**Verdict:** `PHASE 7: ENGINEERING PASS / DEVICE DEFERRED / RELEASE SECURITY EXCEPTION OPEN`

**Implementation commit:** `f36ba1216b4a1b9978650c3ba3dd67773ecd3117`

**Verified:** 2026-07-18 03:48 Asia/Dhaka

**Verifier:** Codex

This is the strongest non-physical engineering verdict. It authorizes Phase 8 preparation, not
production release. The complete signed physical-device matrix, soak and owner acceptance remain
mandatory in Phase 8.

## Delivered controls

- Added a bounded server runtime policy with emergency kill switch, stable cohort rollout, caller
  and caller/callee-pair rate limits, event-ingest limits, maximum call duration and retention.
- Added deterministic bounded reconnect backoff and correlated push-to-ring, join and
  answer-to-audio measurements.
- Added RTT, packet-loss, jitter, bitrate, audio-route and reconnect telemetry on web, iOS and
  Android with a strict allowlist and value-based secret/PII redaction.
- Added 24-hour SLO aggregation and alerting for stuck calls, push rejection, miss/failure spikes
  and degraded media. The authenticated owner Calls panel now renders the live SLO summary.
- Added scheduled health monitoring and retention purge to the existing one-minute reconcile cron.
- Added explicit media-security documentation and UI/API copy: Agora media is encrypted in
  transport; application E2EE is not implemented or claimed.
- Fixed the production `Permissions-Policy` from `microphone=()` to `microphone=(self)`. The former
  header disabled web microphone access even on the first-party app origin.
- Applied all safe non-breaking `npm audit fix` lock updates. Production high findings reduced from
  five to four.

## Hard verification

| Gate | Result |
|---|---|
| Calling regression/chaos suite | PASS — 8 files, 51/51 tests |
| TypeScript | PASS — `npm run type-check` |
| Focused ESLint | PASS — all Phase 7 web/API/test files |
| Prisma schema | PASS — `npx prisma validate` with a non-secret placeholder URL |
| Android | PASS — `:app:compileDebugKotlin :app:testDebugUnitTest` |
| iOS | PASS — fresh unsigned `arm64 + x86_64` generic iOS Simulator build |
| Web production | PASS — optimized Next build, 377/377 static pages |
| Diff hygiene | PASS — `git diff --check` |

The first sandboxed web-build attempt stalled and the clean retry exposed the cause: `next/font`
could not resolve Google Fonts without network access. A clean network-enabled rerun compiled and
generated all 377 pages. Existing OpenTelemetry dynamic-require warnings remained non-fatal.

## Fault, abuse and security evidence

| Scenario | Evidence/result |
|---|---|
| Duplicate create / idempotency | PASS — original call returned; no second session |
| Concurrent answer / terminal transition | PASS — exactly one CAS winner |
| Late answer vs server expiry | PASS — canonical expiry wins |
| Serializable database conflict | PASS — bounded retry succeeds |
| Provider outage / no eligible device | PASS — durable outbox retry/dead semantics; no false connected state |
| Network churn | PASS — bounded reconnect state/backoff; no terminal transition on transient peer loss |
| Kill switch / cohort rollback | PASS — deterministic policy tests |
| Caller and pair abuse limits | PASS — deterministic policy tests and durable DB preflight |
| Telemetry flooding | PASS — 16 KiB request guard and durable per-call/actor limit |
| Secret/PII leakage | PASS — bearer token, 64-hex token, email and Bangladesh phone values redacted |
| Media encryption claim | PASS — E2EE claim is explicitly forbidden until reviewed key distribution exists |

## Dependency review and release exception

`npm audit --omit=dev --audit-level=high` still reports **27 production findings: 4 high and 23
moderate** after safe remediation. The remaining high findings are in the repo-wide Next 14,
Sentry/Rollup and SheetJS dependency baseline. Automated remediation requires breaking framework
upgrades, and SheetJS reports no fix in the current registry advisory. They were not silently forced
inside the calling branch because doing so would materially expand risk across the full ERP.

This exception is **not accepted as safe for production release** by this evidence record. Phase 8
must either (a) land and regress a dedicated dependency-modernization change, (b) replace/isolate the
affected use, or (c) capture explicit owner/security risk acceptance with compensating controls.
Until then, the canary/release gate remains closed even if physical call rows pass.

## Device-deferred rows

- Signed/TestFlight APNs and Android release push delivery.
- Real two-device cross-platform audio, background/killed/locked lifecycle and network handoff.
- Bluetooth/earpiece/speaker, GSM interruption, VoiceOver/TalkBack and OEM/Doze behavior.
- 100-call mixed-platform soak, long-call token renewal, canary SLO comparison and owner acceptance.

All rows above are intentionally batched into Phase 8 under the fixed owner-approved verification
schedule. No physical-device PASS is claimed here.

