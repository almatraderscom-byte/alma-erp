# Office Calling Phase 4 Verification

## Verdict

**PHASE 4: ENGINEERING PASS / DEVICE DEFERRED**

- Implementation commit and embedded release SHA: `29c05478dcfefdd1b5266173b3a05156da131606`
- Branch: `agent/office-calling-whatsapp`
- Verifier: Codex hard gate
- Timestamp: 2026-07-18 01:02 Asia/Dhaka
- Physical Android/OEM matrix: deliberately deferred to Phase 8 by the owner-approved fixed execution goal.

## Scope and lifecycle truth

- Adds one process-level Android call coordinator backed by Jetpack Core-Telecom 1.0.0. Compose sheets, the full-screen activity, notification buttons and FCM receivers now issue intents to that owner rather than owning media themselves.
- Registers `CallsManager`, `MANAGE_OWN_CALLS`, microphone+phone-call foreground-service types and Telecom callbacks for answer, disconnect, active, inactive, mute and endpoint state. API 24–25 retain a guarded notification/Agora fallback; Core-Telecom is entered only on API 26+.
- Adds native owner→staff and staff→owner calls with a unique idempotency key, canonical fetch and outgoing Telecom registration. Both iOS and Android native shells suppress competing WebView call controls/Agora clients.
- Direct FCM and the legacy OneSignal compatibility path treat push as an untrusted wake hint. Incoming and cancel events reconcile participant-authenticated canonical state before surfacing or dismissing an OS call.
- Incoming and ongoing notifications use `NotificationCompat.CallStyle`, per-call IDs, immutable unique PendingIntents and Answer/Decline/Hang Up actions. Notification denial and Android 14 full-screen-intent denial are detected; heads-up fallback and settings shortcuts are exposed.
- Notification BroadcastReceiver uses `goAsync()` until the canonical action is issued. A fast answer/end before Telecom call-control readiness is queued and replayed when the control scope arrives.
- Foreground-service launch failures are no longer swallowed. They update visible capability state and emit sanitized telemetry. Ongoing calls use a silent CallStyle replacement so an outgoing call does not play the incoming ringtone.
- Sheet dismissal only minimizes an active call; the ongoing system notification is the global return surface. Explicit end controls transition canonical state before local teardown.
- Answer, decline, cancel, hang-up, timeout, Telecom action and canonical remote end converge on the Phase 1 state machine. Client ring timeout only triggers canonical reconciliation and never invents a missed state.
- Agora peer appearance promotes only through legal `ANSWERED → CONNECTING → CONNECTED` transitions. First peer-offline/connection loss enters one immutable 15-second reconnect window instead of ending immediately.
- Agora token expiry/request callbacks renew tokens. Private calls default to earpiece, expose speaker/Telecom endpoints, request Bluetooth permission and restore the pre-interruption mute state.
- Telemetry uses an installation UUID rather than a hardware Android ID; logs contain no FCM/Agora tokens.

## Defects found and fixed during the hard gate

1. Telecom active callback called `setActive()` recursively — removed; only peer-connected promotion sets active.
2. Local teardown cancelled the `addCall` coroutine before Telecom disconnect completed — disconnect now completes before registration cleanup.
3. A normal coroutine cancellation was treated as a Telecom failure — `CancellationException` is explicitly ignored.
4. Answer/active/end could arrive before `CallControlScope` — pending actions are queued and replayed.
5. Call-control endpoint collectors were launched outside the call scope and could leak — collectors now inherit `CallControlScope` cancellation.
6. Notification action receiver returned before canonical network work — fixed with `goAsync()` completion.
7. Forged/stale cancel push could dismiss a live ring — cancel now requires canonical `ENDED` before notification/Telecom cleanup.
8. Incoming Activity process restart trusted notification extras without canonical state — it now re-enters through canonical reconciliation.
9. Incoming answer could cancel the newly-created ongoing FGS notification because both use the call ID — explicit cancel removed; the ongoing CallStyle replaces it.
10. Outgoing ongoing notification could play the high-importance call channel ringtone — ongoing notification is explicitly silent/only-alert-once.
11. API-24 builds referenced API-26 `java.time` and Core-Telecom without a guard — replaced by API-safe ISO helpers and API-gated Telecom entry.
12. Remote canonical terminal state was flattened to local/completed Telecom history — canonical terminal reason now maps to rejected/cancelled/missed/busy/error outcomes.
13. Compose canonical state was mutated from an IO thread despite the manager's main-thread contract — protocol state now uses a volatile backing value and main-thread observable publication.
14. GSM/Telecom inactive→active left the microphone permanently muted — the previous mute state is restored.

## Automated and artifact hard gates

| Gate | Result |
|---|---|
| TypeScript typecheck | PASS — `tsc --noEmit` |
| Focused canonical auth/device/domain/observability/outbox suite | PASS — 5 files, 35 tests |
| Android call-policy/API-24 time unit tests | PASS — 4 tests, 0 failures; repository sample test also passed |
| Debug Kotlin/Java compile + debug APK | PASS |
| R8/shrunk arm64 Release APK | PASS — `BUILD SUCCESSFUL in 5m 15s` |
| Release identity | PASS — `com.almatraders.erp`, `1.2.1 (13)`, min 24, target/compile 35 |
| Embedded release SHA | PASS — `29c05478dcfefdd1b5266173b3a05156da131606` |
| Embedded production URL | PASS — `https://alma-erp-six.vercel.app` |
| Release APK | PASS — 46 MB; SHA-256 `fc299cfe30a465f175605e7412eeff24891c1efb86f29dbb7242ad70d9fa2ca7` |
| Packaged permissions/components | PASS — Bluetooth Connect, full-screen intent, phone-call FGS, own-calls, direct FCM service, action receiver and call activity present |
| Packaged FGS type | PASS — manifest bitmask `0x84` = microphone + phoneCall |
| R8 manifest entry preservation | PASS — action receiver class remains in release DEX |
| Full Android lint | Repository gate remains red with 7 pre-existing unrelated errors and 37 warnings; calling-file lint errors = **0** after fixing all Phase 4 NewApi/static-leak findings |
| Native WebView ownership scan | PASS — both iOS and Android native shells suppress dock, incoming overlay, active overlay and staff call-owner action |
| Navigation-drop scan | PASS — sheet `onDismissRequest = onDismiss`; only explicit live-walkie-talkie stop still calls `leave()` |
| `git diff --check`, clean tree and push | PASS |

## Emulator/runtime boundary

No Android Virtual Device is configured on this Mac (`emulator -list-avds` returned none). Per the fixed schedule, no physical phone was reconnected or modified. The debug and release artifacts, merged manifest, release DEX and lifecycle contracts were therefore hard-verified without claiming runtime audio/notification proof.

## Toolchain boundary

AGP 8.5.2 reports that it was tested only through compile SDK 34 while the project targets 35. Its lint/R8 front-end also emits Kotlin 2.2 metadata warnings from current Capacitor/OneSignal dependencies. Debug and release compilation, lint-vital and R8 packaging completed; full lint's seven errors are in unrelated baseline files. AGP/Kotlin alignment remains a Phase 7 toolchain-hardening item, not hidden Phase 4 evidence.

## Physical-device boundary

Pixel/AOSP, Samsung and aggressive-OEM foreground/background/killed/locked/Doze calls; denied-notification/full-screen fallbacks; `dumpsys telecom`; FGS/Logcat/server correlation; wired/Bluetooth/Wear/GSM controls; Android↔Android and Android↔iOS streaks are `DEVICE DEFERRED` to Phase 8. Phase 4 authorizes Phase 5 engineering work, not release or a fully WhatsApp-like claim.
