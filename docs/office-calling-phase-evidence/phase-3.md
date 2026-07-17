# Office Calling Phase 3 Verification

## Verdict

**PHASE 3: ENGINEERING PASS / DEVICE DEFERRED**

- Native implementation commit: `4d64f82fada4ce44bba3f17f9ed88fae3d62a0ea`
- Latest-main merge / archived implementation SHA: `1872a255cae7f2ad791b77261251b1cda4af236c`
- Embedded archive SHA: `1872a255ca`
- SHA-stamp commit before this evidence record: `fda04cc085c68c79f2829c1b597d8175fffb0b65`
- Branch: `agent/office-calling-whatsapp`
- Verifier: Codex hard gate
- Timestamp: 2026-07-18 00:21 Asia/Dhaka
- Physical iPhone matrix: deliberately deferred to Phase 8 by the owner-approved fixed execution goal.

## Scope and lifecycle truth

- Replaces view-owned private-call state with one process-level `OfficeCallCoordinator` observed by all native call UI.
- Native owner-to-staff and staff-to-owner calls both create a canonical server call and enter CallKit through a deterministic server UUID.
- Incoming PushKit and foreground-poll delivery deduplicate on the same UUID and fetch canonical state before the call remains visible.
- Outgoing calls use `CXStartCallAction`, connecting/connected reporting and CallKit-owned audio activation.
- Answer, end, reset and mute CallKit actions converge on idempotent canonical transitions; a failed OS end transaction falls back to canonical termination instead of leaving a ghost call.
- Canonical terminal reasons map to CallKit `unanswered`, `declinedElsewhere`, `failed` or `remoteEnded` history outcomes.
- A fast CallKit answer can no longer race the post-report canonical fetch and be incorrectly ended as stale.
- Peer presence no longer attempts illegal `RINGING -> CONNECTED`; it waits for `ANSWERED` and advances only through legal canonical states.
- Repeated Agora reconnect callbacks cannot reset the 15-second grace indefinitely. Audio interruption, connection changes, peer-offline, token renewal and route changes are handled explicitly.
- Private calls default to earpiece with proximity monitoring; native UI exposes speaker/route, mute, minimize/return and end.
- Navigation dismissal leaves an active call alive. The app-wide floating head becomes a return-to-call surface while the coordinator owns media.
- iOS shell web call UI, incoming takeover and the previously missed staff group-chat “call owner” button are suppressed, removing the split native/web caller.
- Logout/token invalidation continues to remove the current installation binding from Phase 2.

## Defects found and fixed during the hard gate

1. Swift actor isolation violation in audio-session route update — fixed and rebuilt.
2. Agora peer join could precede the callee `ANSWERED` write and attempt illegal `RINGING -> CONNECTED` — fixed with bounded canonical promotion/retry.
3. Repeated reconnect/failed callbacks restarted the grace window forever — fixed with one immutable active deadline.
4. CallKit end-transaction failure left canonical state active — fixed with direct canonical fallback.
5. Fast user answer raced post-report reconciliation and could end a valid call — fixed by preserving the already-active matching call.
6. Server missed-timeout and native timeout could diverge, leaving a ghost ring — native now reconciles and lets the server own `MISSED`.
7. Failed CallKit start/answer actions retained stale UUID mappings — fixed with action-failure cleanup.
8. Remote termination did not clear CallKit audio ownership or preserve terminal history semantics — fixed.
9. Staff group-chat still exposed the web `callOwner()` button inside iOS — hidden in the native shell.

## Automated and artifact hard gates

| Gate | Result |
|---|---|
| Full iOS Debug simulator workspace build (arm64 + x86_64) | PASS — repeated after each lifecycle hardening batch |
| Final iOS Release generic-device archive | PASS — `** ARCHIVE SUCCEEDED **` |
| Archive build/version/SHA | PASS — `1.0 (77)`, `1872a255ca` |
| Archive production base URL | PASS — `https://alma-erp-six.vercel.app` |
| Archive background modes | PASS — `audio`, `voip`, `remote-notification`, `fetch` |
| Archive microphone disclosure | PASS — explicitly includes Office voice calls |
| Source entitlements | PASS — `aps-environment` plus `group.com.almatraders.erp`; provisioning-derived production entitlement requires a signed Phase 8 artifact |
| Booted iPhone simulator install and launch | PASS — PID returned, no crash/fatal launch evidence |
| TypeScript typecheck after latest-main merge | PASS |
| Focused canonical domain/outbox/observability suite | PASS — 3 files, 26 tests |
| iOS feature parity contract | PASS — 43 surfaces, 104 actions, 0 open tracked actions |
| ESLint | PASS with repository-pre-existing warnings only; no Phase 3 error |
| Static navigation-drop scan | PASS — no unconditional active-call `onDisappear -> leave` |
| Static iOS web-call ownership scan | PASS — owner dock, incoming/call UI and group-chat staff call action suppressed |
| `git diff --check` and clean pushed tree | PASS |

## Simulator/runtime boundary

The final Debug build installed and launched on the booted iPhone 17 Pro Max iOS 26.5 simulator. Launch logs contained no crash, fatal error or signal termination. Simulator runtime cannot deliver production PushKit/CallKit lock-screen behavior or prove two-way microphone audio, so it is supporting evidence only.

## Physical and signing boundary

The Phase 3 archive was intentionally unsigned (`CODE_SIGNING_ALLOWED=NO`), so its embedded Info/background modes and binary are inspectable but it has no provisioning-derived signed entitlements. TestFlight PushKit delivery, production `aps-environment`, two-iPhone foreground/background/killed/locked calls, lock-screen/headset controls, Wi-Fi/cellular churn, GSM interruption, Bluetooth routing and the 30-call streak are `DEVICE DEFERRED` to Phase 8. Phase 3 therefore authorizes Phase 4 engineering work under the fixed execution schedule, not release or a “fully WhatsApp-like” claim.

## Known non-blocking boundary

Swift 6 sendability diagnostics remain warnings under the project's Swift 5 language mode, along with existing unrelated native warnings. They did not fail Debug or Release builds; strict concurrency cleanup can be enforced in Phase 7 quality hardening without weakening the Phase 3 lifecycle contract.
