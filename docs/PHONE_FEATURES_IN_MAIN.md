# Phone system — what is in `main` today (2026-07-25)

A feature checklist for the call system as it actually ships, and **how each thing is
controlled today**. The last column is the point of this document: almost everything works,
and almost nothing has a screen. That gap is what `ALMA_PBX_CONSOLE_ROADMAP.md` plans to close.

Control legend: **UI** = a screen in ALMA ERP · **KV** = `agent_kv_settings` row (no screen,
changed by asking the agent or by hand) · **env** = a variable on the VPS or Vercel, needs SSH
or the Vercel dashboard · **conf** = a file on the VPS, needs SSH · **none** = code only.

---

## A. Calls in and out

| Feature | Works | Lives in | Controlled by |
|---|---|---|---|
| Inbound call answered by the AI, in Bangla | ✅ | `sip-inbound/route.ts` + gemini-live-bot | env `SIP_INBOUND_VOICE` |
| Real caller-ID, so the owner is recognised ("জি বস") | ✅ | `isOwnerNumber()` | env `OWNER_PHONE_NUMBERS` |
| Outbound AI call (two-way, Gemini Live) | ✅ | `placeSipLiveCall()` → gateway → Asterisk | env `VOICE_CALL_PROVIDER=sip` |
| One-way message call (speak and hang up) | ✅ | `outbound_phone_call` tool | — |
| Owner's own todo/ERP reads mid-call | ✅ | `ERP_FN_DECLS` + `erp-tool` allowlist | none (code) |
| Staff names + today's attendance sent WITH the call | ✅ | `buildOwnerCallFacts()` | none (code) |
| Voice: male Charon default, female only on request | ✅ | `voice-provider-intent.ts` | none (code) |
| Daily call cap (outbound that actually connected) | ✅ | `callsPlacedToday()` | env `VOICE_CALL_DAILY_CAP` |
| Runaway-loop backstop (3× the cap in attempts) | ✅ | `callAttemptsToday()` | none |
| BD-only destinations, no international | ✅ | `from-staff` dialplan | **conf** |
| Concurrency cap (matches the trunk's limit of 2) | ✅ | gateway | env `SIP_MAX_CONCURRENT_CALLS` |

## B. What happens during a call

| Feature | Works | Lives in | Controlled by |
|---|---|---|---|
| Transfer to a human when asked, or when it matters | ✅ | `forward_call` tool in the bot | env `SIP_FORWARD_SUPPORT` / `SIP_FORWARD_BOSS` |
| Press 0 for a human | ✅ built, 👤 unproven live | gateway DTMF handler | env (same two) |
| Ring group, 2 rounds, then back to the AI | ✅ | `dialNextInGroup()` | env `SIP_TRANSFER_ROUNDS` |
| **Hold audio — the owner's own recording** | ✅ | `alma-hold` MOH class | env `SIP_MOH_CLASS` + **conf** |
| Voicemail when the AI cannot speak | ✅ | `sip-voicemail/route.ts` | env `SIP_VOICEMAIL_MAX_SECS` |
| Office-hours routing | ✅ | `sip-inbound` | **KV** `office_hours_dhaka` |
| Ask-first vs direct transfer | ✅ | bot `requestForward()` | **KV** `inbound_transfer_mode` |
| Spam/blocked callers refused before answering | ✅ | `isBlockedCaller()` | **KV** `blocked_callers`, env `SIP_BLOCKLIST` |
| Barge-in (interrupt the AI mid-sentence) | ✅ | gateway fade + bot | env `SIP_BARGE_FADE_FRAMES` |
| Turn detection (how fast it replies) | ✅ new | bot `vadCfg()` | env `GLIVE_VAD_SILENCE_MS` |
| Jitter cushion + overrun recovery | ✅ new | gateway playout | env `SIP_JITTER_*`, `SIP_QUEUE_*` |

## C. After the call

| Feature | Works | Lives in | Controlled by |
|---|---|---|---|
| Recording of the whole bridge (survives transfer) | ✅ | gateway → Supabase | env `SIP_DEBUG_RECORD` |
| Recording delivered to Telegram as playable audio | ✅ | `voice-call-delivery.ts` | none |
| 30-day recording retention | ✅ | cleanup job | none |
| Bangla summary + transcript stored | ✅ | `agent_voice_calls` | none |
| Per-call CDR posted back to the ERP | ✅ | `sip-cdr/route.ts` | none |
| Outcome sweep (busy / no answer / failed, real cause) | ✅ | `ngs-call-outcome.ts` | none |
| Unknown caller → "shall I save this number?" | ✅ | `voice-call-delivery.ts` | none |
| Unanswered-call retry ladder | ⚠️ unit-tested | `call-retry-policy.ts` | env `MAX_CALL_RETRIES` |
| Per-call audio quality numbers (underruns, cushion) | ✅ | gateway log line | **none — log only** |

## D. Staff browser phone

| Feature | Works | Lives in | Controlled by |
|---|---|---|---|
| Softphone at `/agent/phone` (the only phone SCREEN we have) | ✅ | `SoftphonePanel.tsx` | **UI** |
| Registers over TLS (wss), keypad, mute, speaker | ✅ | `useSoftphone.ts` | UI |
| Screen-pop: caller's orders, dues, recent calls | ✅ built, 👤 unproven live | `phone/caller/route.ts` | UI |
| Colleague directory + free staff-to-staff calls | ✅ | `phone/dial/route.ts` | UI |
| Click-to-call from the ERP | ✅ | gateway `click2call` | UI |
| Staff extension provisioning (create/rotate) | ✅ API only | `phone/credentials/route.ts` | **none — no screen** |
| Softphone stack watchdog + self-heal | ✅ | gateway `checkSoftphoneStack()` | env `SIP_WS_CHECK_SECS` |

## E. The line itself

| Feature | Works | Lives in | Controlled by |
|---|---|---|---|
| SIP trunk to the provider | ✅ | `pjsip.conf` on the VPS | **conf** |
| Registration every 60 s (the outbound root cause) | ✅ | `alma-reg` | **conf** |
| Registration watchdog + owner alert | ✅ | gateway `checkRegistration()` | env `SIP_REG_*` |
| SIP port firewall, survives reboot | ✅ | nftables + systemd | **conf** |
| Toll-fraud guards (signed calls, BD-only, key checks) | ✅ | gateway | env |
| Provider cost / balance / rate plan | ❌ **not in ALMA at all** | provider's own panel | their website |

---

## The honest summary

**Everything above works. Exactly one screen exists** — the staff softphone at `/agent/phone`.
Every other control is an env var behind SSH, a config file on the VPS, or a KV row with no
screen. The owner cannot today, from the ERP:

- see whether the line is registered, or who is on a call right now
- read call logs, listen to recordings, or see why a call failed
- see what a call cost, or what is left with the provider
- change the forward numbers, office hours, blocklist, or the AI's voice
- add or disable a staff extension
- add, edit or check a trunk

That list is the roadmap.
