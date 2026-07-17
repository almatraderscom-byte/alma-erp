# Office Calling Phase 5 Evidence — Web global call client

Date: 2026-07-18 (Asia/Dhaka)
Branch: `agent/office-calling-whatsapp`
Implementation commits:
- `d8d2f62d9cf43051c31b6f96efa226c85807fb8b` — global coordinator/protocol
- `a2eb70fb334dd35f9c6982bc64a6957ed4bd6f8d` — single-tab media ownership
- `d3854339b6c4708616a1bcaf15f464a59d4610e4` — Web Locks failure fallback

## Gate result

`ENGINEERING PASS / DEVICE DEFERRED`

This is not a production/release PASS. Web↔iPhone, web↔Android, multi-browser
desktop media and the signed-build 30-call matrices remain Phase 8 physical
verification rows.

## Implemented contract

- `OfficeCommunicationProvider` now owns the intercom/call engine above the
  authenticated route tree. Office group chat consumes that shared instance;
  closing the drawer or navigating away from `/portal/office` no longer unmounts
  the call engine.
- Incoming/active/minimized/reload-recovery call surfaces render globally. Native
  shells remain dark because CallKit/Core-Telecom retain lifecycle ownership.
- Canonical state uses an authenticated SSE endpoint with a 12-second bounded
  reconciliation poll. The 50-second stream rotates cleanly for serverless
  runtimes and closes on terminal state or unsupported/legacy deployment.
- Join uses an abort controller plus monotonically increasing generation guard
  across token fetch, dynamic SDK import, Agora join, permission prompt, track
  creation and publish. `leave()` and teardown are idempotent.
- Web Locks grant exactly one tab media ownership for each call. A bounded,
  self-revoking storage lease covers browsers without Web Locks; losing a lease
  tears down the stale tab. The 30-cycle policy test proves owner re-entry,
  competing-tab rejection and post-expiry takeover.
- Agora connection, network-quality, token-expiry, microphone-change and
  playback-device-change events are handled. Token renewal calls the same
  participant-authorized token route with `renewal: true`.
- Canonical tokens return the other participant's stable UID. Web rejects a
  remote UID that is not the authorized peer and locks legacy calls to the first
  established remote UID.
- Microphone/output selection, permission/busy/not-found diagnostics, mute,
  network quality, offline/reconnect state, background/foreground and page-unload
  telemetry are implemented.
- Web answer promotes canonical `RINGING → ANSWERED`; peer presence promotes
  `ANSWERED → CONNECTING → CONNECTED`; transport loss/recovery uses
  `RECONNECTING → CONNECTED`. Create actions carry per-attempt idempotency keys.
- A browser reload intentionally does not claim to preserve `MediaStream`.
  Instead, an unfinished outgoing canonical leg displays an explicit resume/end
  surface; incoming legs return to the global ring surface.

## Hard verification

| Gate | Result |
|---|---|
| `npm run type-check` | PASS |
| Calling-scope ESLint | PASS, zero findings |
| Call-domain/web policy Vitest | PASS — 6 files, 39 tests; includes 30-cycle two-tab ownership |
| Full repository Vitest | PASS — 214 files, 2,586 tests. The PDF/Chromium smoke was the sole sandbox-launch failure and passed 2/2 when rerun with local Chromium permission |
| `git diff --check` | PASS |
| Prisma schema validation | PASS |
| Production `next build` (Sentry upload disabled; no deploy/migration) | PASS — compiled, 377 pages generated, new SSE route present |
| Built-chunk inspection | PASS — root provider, lease fallback, token/network/device handlers and `call_active_in_another_tab` are present in the generated client chunk |
| Static root-lifecycle contract | PASS — provider is mounted in `AppProviders`; `GroupChat` has no `useIntercom` owner |
| Static Agora fault contract | PASS — generation/abort, unexpected-peer rejection, connection/network/token/device handlers and media teardown present |
| Vercel exact-SHA deployment | PASS — GitHub status for `d3854339b6c4708616a1bcaf15f464a59d4610e4` reports `Deployment has completed` at 2026-07-17 19:37:24 UTC |

The first production build attempt exhausted the local disk while writing the
disposable `.next/cache` (`ENOSPC`). Only that generated 1.4 GB cache directory
was removed; the clean retry passed. The build's two unauthenticated approval
warnings occurred during static page collection and are unrelated baseline
behavior.

## Browser/physical deferrals

- The preview alias is protected by Vercel SSO. The current in-app browser session
  reached Vercel login rather than the app, so no authenticated preview UI row is
  fabricated here. Production compilation and exact-SHA Vercel deployment are
  the strongest available gates in this run.
- Chrome/Safari/Edge two-tab media, device removal, real token expiry, heap/audio
  inspection, and the 30-call desktop matrix require authenticated media peers.
- Web↔web, web↔iOS and web↔Android in both directions remain `DEVICE DEFERRED` to
  Phase 8, together with final call-history/telemetry correlation.

## Residual risks carried forward

- A live browser tab can maintain an Agora call across SPA navigation; a killed
  browser cannot match native CallKit/Core-Telecom background guarantees.
- Audio output switching depends on browser `setSinkId`/Agora support; Safari may
  expose only the system-default output.
- Serverless SSE is intentionally short-lived and reconnecting; bounded polling
  remains the correctness fallback.
