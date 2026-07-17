# ADR: Office Calling Ownership and Observability

- Status: accepted for Phase 0; authoritative session implementation is deferred to Phase 1
- Date: 2026-07-17
- Scope: web, native iOS, native Android, server, Agora, APNs, FCM, OneSignal

## Decision

The server owns call identity, participant authorization, canonical state, terminal reason,
and the event ledger. A client owns only its local media/audio session and reports facts it
observed. Agora is the media plane, not the source of business truth. Push providers are wake
and delivery transports, not state stores.

Every one-to-one call uses the legacy broadcast UUID as its Phase 0 `callId` and the exact
Agora channel `itc_<callId>`. Phase 1 will introduce the authoritative call-session model while
preserving this correlation key and the append-only event ledger.

## Target state machine

```text
created -> ringing -> answered -> connecting -> connected -> reconnecting
   |          |          |             |            |             |
   +----------+----------+-------------+------------+-------------+
                                   -> ended
```

Terminal reasons are `declined`, `cancelled`, `missed`, `completed`, `failed`, and `busy`.
Only the server may accept a state transition. Client events are observations and cannot move
canonical state by themselves. Duplicate and out-of-order observations remain append-only.

## Frozen product constants

| Contract | Phase 0 value |
|---|---:|
| Ring timeout | 60 seconds |
| Peer-left grace | 5 seconds (measured current behavior; Phase 7 may change it) |
| Agora token TTL | 3,600 seconds |
| Wake-push TTL | 45 seconds |
| Maximum call duration | 2 hours |
| Busy policy | Reject the new call |
| iOS support | iOS 17+ for native calling |
| Android support | Android 7.0+ / API 24+ |
| Web support | Current and previous major Chrome, Safari, Edge, and Firefox |

These values are exported by `office-call-observability.ts` and returned by the owner-only
call diagnostics API. Phase 1 must enforce ring expiry, maximum duration, and busy policy on
the server; declaring values here does not pretend the legacy clients already enforce them.

## Event and privacy contract

Required correlation fields are `callId`, source/platform, event, state, build, timestamp,
provider result category, and latency when known. Client device identifiers are HMAC-pseudonymized
on the server. Raw push tokens, authorization headers, cookies, certificates, passwords,
private keys, phone numbers, and provider response bodies are forbidden. Metadata is depth,
key-count, array-size, and string-length bounded before persistence and logging.

## Ownership boundaries

| Component | Owns | Must not own |
|---|---|---|
| Server | identity, participant access, canonical state, timeout, terminal reason, ledger | microphone/audio route |
| Web/iOS/Android | local RTC engine, permissions, audio route, UI rendering | canonical terminal truth |
| Agora | media membership and audio transport | call authorization or history |
| APNs/FCM/OneSignal | wake/delivery attempt | proof that the user rang or answered |
| Legacy receipt | history acknowledgement | cross-device ring cancellation |

## Reproducible device lab

Use release-like builds against one backend/build SHA. Record the backend SHA, native app
version/build, anonymized device IDs, OS versions, network, call ID, event export, and screen
recording for every row.

Minimum devices:

- iPhone A and iPhone B, both physical, with one locked/background/killed case each.
- Android A and Android B from different OEMs, both physical, with Doze/battery optimization cases.
- One desktop browser and one mobile browser for web legs.

For each direction run foreground, background, locked, killed-process incoming wake, navigate
away while connected, network loss/recovery, Bluetooth/speaker route, decline, caller cancel,
timeout, duplicate push, and answer on a second device. Simulator/emulator runs prove compile,
launch, and deterministic UI only; they never count as call reliability evidence.

## Consequences

Phase 0 can reveal exactly where a call stops, but it cannot make the legacy split-brain flow
reliable. Phase 1 must introduce authoritative sessions/transitions and idempotent participant
actions before push or native lifecycle rewrites begin.
