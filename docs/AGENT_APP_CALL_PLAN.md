# Agent → Owner In-App Two-Way Call — Full Plan

Owner request (2026-07-29): the agent already places live two-way calls to WhatsApp
and direct (PSTN) numbers. It must ALSO be able to ring the owner **inside the ALMA
iOS app itself** — a WhatsApp-style incoming call that works anywhere in the world
over the internet, including the UAE where WhatsApp/FaceTime calls are blocked.

## 0. What already exists (audit result, 2026-07-29)

The hard parts are already shipped and live:

| Piece | Where | Status |
|---|---|---|
| APNs **VoIP push** (ring/cancel) | `src/agent/lib/apns-voip.ts` (`sendVoipCall`) | LIVE — used by Office Intercom app-to-app calls |
| **PushKit + CallKit** full-screen incoming call | `ios/App/App/CallKitVoIP.swift` (411 lines) | LIVE — rings even when app is killed |
| Device token registry (encrypted at rest) | `office-call-devices.ts`, `/api/assistant/internal/call-push/register` | LIVE |
| Durable call state machine + push outbox (5 retries) | `office-call-domain.ts`, `office-call-outbox.ts` | LIVE (flag `OFFICE_CALL_SESSIONS_ENABLED`) |
| Native full-duplex voice engine (Gemini Live, barge-in, reconnect) | `ios/App/App/AssistantVoiceSwiftUI.swift` → `AlmaGeminiLiveSession` | LIVE — the voice-console orb |
| Ephemeral Gemini token minting | `/api/assistant/live-session` | LIVE (owner-only, 30-min token) |
| Escalation ladder that decides WHEN to call the boss | `src/agent/lib/proactive-call.ts` (PA-2) | LIVE — currently WhatsApp → PSTN |
| Android incoming-call path (FCM full-screen intent) | `OfficeCallFirebaseService.kt` | LIVE |

**The single missing piece:** nothing lets the *backend* start a voice session — the
owner always pulls (taps the orb / answers an intercom call from a staff member).
There is no "agent rings the app" trigger and no media path for the agent once the
owner answers.

## 1. Architecture decision — media path

Two options for what the owner hears after tapping "answer":

- **(A) App-side Gemini Live — RECOMMENDED.** On CallKit answer the app starts the
  existing `AlmaGeminiLiveSession` (same engine as the voice-console orb), with a
  per-call brief injected so the agent opens the conversation with WHY it called.
  No new vendor, no server media bot, reuses barge-in/reconnect/echo work already
  proven on-device. The "call" is: VoIP push rings CallKit → answer → app connects
  to Gemini Live over WSS 443 → agent speaks its brief → normal two-way talk with
  mid-call ERP tools.
- (B) Agora channel + server-side bot. Reuses office-call plumbing verbatim, but
  requires a server-side Agora participant (Linux SDK or Conversational AI Engine)
  that does not exist in the repo — new vendor surface, new cost. Keep as fallback
  only if (A)'s call quality disappoints.

**UAE / abroad answer:** WhatsApp calls are blocked by the UAE TDRA at the
app/protocol level. Our path is different end to end: the ring is an APNs push
(never blocked — every iPhone notification uses it) and the audio is a TLS
WebSocket to Gemini on port 443 — ordinary HTTPS traffic, not a known VoIP app
signature. This is the same reason the voice-console orb already works from Dubai.
So yes: **the app can ring the owner in the UAE** where a WhatsApp call cannot.
(If a network ever throttles the Gemini WSS, fallback is proxying the WSS through
our own domain on 443 — one route, no client change.)

## 2. Phases

### C1 — Server: "ring the owner's app" primitive
- New internal route `POST /api/assistant/internal/agent-app-call` (auth:
  `AGENT_INTERNAL_TOKEN`, same pattern as `native-push`): creates a call row, sends
  `sendVoipCall(tokens, { type:'agent_call', callId, caller:'ALMA', event:'ring' })`
  to the owner's registered VoIP devices, schedules `event:'cancel'` + status
  `unanswered` at the 60-s ring timeout.
- Call record: new small table `agent_app_calls` (id, purpose, brief, status
  ringing/answered/completed/unanswered/declined, timestamps, summary). Deliberately
  NOT forcing the office-call state machine (it requires two real User rows and
  cookie auth); revisit merging later.
- New head tool `ring_owner_app` in `personal-tools.ts` beside `place_agent_call`,
  same daily-cap/rate-limit treatment as owner calls (`urgent-rate-limit.ts`).

### C2 — iOS: answer path
- `CallKitVoIP.swift`: recognize payload `type:'agent_call'`; on answer, instead of
  `OfficeCallCoordinator.startCall` (Agora), start `AlmaGeminiLiveSession` with the
  `callId`; report connected to CallKit; on hangup end the session and POST the
  status.
- `/api/assistant/live-session`: accept optional `callId` — injects the call's
  purpose/brief into the per-session system instruction ("তুমি Boss-কে কল করেছ কারণ …
  — সালাম দিয়ে কারণটা আগে বলো") and marks the row answered. Mint the ephemeral token
  ON ANSWER, not on ring (its new-session window is only 60 s).
- Post-call: session-end summary posted back (same contract as the SIP bot's
  post-call summary) so the conversation feed shows what was said.
- Entitlement check before ship: signed archive must carry `aps-environment=
  production` and `APNS_PRODUCTION=true` on Vercel, else rings silently fail with
  BadDeviceToken.

### C3 — Routing: make every escalation international-safe
- PA-2 ladder (`proactive-call.ts` `startEscalationLadder`): insert **stage 0 =
  app ring**, then existing WhatsApp → PSTN → push. One edit covers approval-stuck,
  staff-task-stuck, business alerts and boss-callback.
- Honor the new `owner_abroad_calls_off` toggle (shipped 2026-07-29): when ON, the
  ladder SKIPS the WhatsApp and PSTN stages entirely — app ring + Telegram/ntfy only.

### C4 — Salah calls through the app when abroad
- Worker salah scheduler: at the points that today place a Twilio call (tier-3
  `deliverSalahAlert`, post-snooze follow-up), when `owner_abroad_calls_off` is ON,
  call the C1 internal route instead of skipping — so abroad the owner still gets a
  real RING for salah, just through the app instead of the dead BD number.
- Keep the toggle's current behavior (suppress → tier 2) until C1/C2 are proven,
  then flip salah to app-ring.

### C5 — Android parity (later)
- Same C1 payload via existing FCM full-screen-intent path; answer path opens the
  Compose voice session. Deferred until iOS is proven.

## 3. Order & effort
1. C1 (server ring + tool) — one session, testable with sim.
2. C2 (iOS answer → Gemini Live) — one session + ONE batched TestFlight build
   (sim-verified first, per repo rule).
3. C3 (ladder + abroad-toggle routing) — small, same session as C2 if time allows.
4. C4 (salah app-ring) — after owner confirms C2 call quality from Dubai.
5. C5 Android — separate branch later.

## 4. Non-negotiables
- **Locked audio tuning untouched** — this plan never touches
  `sip-gateway-service.mjs` playout or `gemini-live-bot.mjs` VAD/forwarding. The
  app path uses the app's own audio engine.
- Kill switch: `AGENT_APP_CALL_ENABLED` env + daily cap, like every other call path.
- No new vendor in the recommended path; costs = one Gemini Live session per call
  (same as a voice-console session).
