# Self-Hosted SIP — Full Build Roadmap (NGS Replacement)

> STATUS 2026-07-25: FEASIBILITY PROVEN LIVE, BOTH DIRECTIONS. Owner decision: build our
> own custom self-hosted phone stack with ALL agent features, drop the monthly NGS fee.
> NGS stays primary + fallback until self-host is 100%.

## THE PROOF (done this session — not theoretical)
VPS 31.97.237.40 (Ubuntu 24.04, Asterisk 20 already installed, chan_audiosocket running),
against the owner's own trunk 103.170.231.10:5060 (user 09649777738 = the DID, password in
VPS env):
- Outbound: Asterisk originated a real call -> owner's phone rang -> answered (channel Up)
  -> played demo-congrats audio. Owner confirmed twice.
- Inbound: with NGS temporarily off (owner set NGS trunk port wrong), a call to the DID
  reached OUR Asterisk (from-alma dialplan answered + played audio).
- Caller-ID (the whole point): inbound INVITE From carried the real number:
  From: <sip:+8801779640373@103.170.231.10:5060>. NGS strips this; SIP gives it directly
  -> owner-recognition ("জি বস") will work.

## ROOT CAUSES DIAGNOSED (tcpdump, not guessed) — bake into the build
1. Trunk ignores source port 5060; answers only non-5060 sources. FIX = dedicated pjsip
   transport bound to 5062 for this trunk. Proven config: worker/deploy/asterisk/alma-trunk.conf
2. AOR qualify_frequency=0 (trunk ignores OPTIONS; qualify -> Unavailable -> origination refused).
3. INVITE/REGISTER auth realm semux.io qop=auth — Asterisk pjsip handles automatically
   (raw-Node needed hand-rolled qop; that is WHY we use Asterisk).
4. Single SIP account: NGS re-registers ~60s and wins the binding -> inbound migration is a
   CLEAN CUTOVER (NGS registration off), not parallel. Outbound needs NO registration (peer
   INVITE) so it runs parallel behind the provider flag.
5. Dial format: local 01XXXXXXXXX@alma (NOT +880). Inbound From arrives as +880.
6. SIP scanners hammer the open 5060 live — firewall 5060/5062 to the trunk IP only.

## CURRENT VPS STATE (left clean for the build)
Asterisk has the alma outbound trunk + transport-alma:5062 + from-alma/alma-in test dialplan.
OUR registration REMOVED so NGS is uncontested primary/fallback. NGS (EasyPBX) fully restored
by the owner (port back to 5060), live line normal. pjsip.conf.bak-* backups on the VPS.

## FULL NGS CONFIG (to replicate/retire — copied from the EasyPBX panel)
Trunk id31: register+peer 103.170.231.10:5060 udp, user 09649777738, unlimited. Outbound
route patterns 01*/880* -> trunk. Inbound route: DID -> CUSTOM FUNCTION "Answer URL"
(.../ngs-inbound?k=SECRET, no caller var = the bug). License: 100 calls.

# BUILD PHASES (feasibility proven; now engineering)

## Phase 1 — Outbound via SIP behind VOICE_CALL_PROVIDER='sip'  ✅ BUILT + LIVE-PROVEN 2026-07-25
DONE (owner-verified on his phone, call sip-06ead6fb… and two more):
- `worker/src/voice-relay/sip-gateway-service.mjs` (pm2 `alma-sip-gateway`): ARI (REST + events WS)
  originates the trunk leg into Stasis app `alma-sip`, bridges it to an externalMedia AudioSocket
  channel (encapsulation=audiosocket, transport=tcp, Asterisk=client), transcodes slin8k<->μ-law,
  and speaks the EXACT NGS-shaped WS frames to the unchanged Gemini Live bot. NGS-shaped control
  API (POST/DELETE/GET/PUT /api/v1/call, X-Authorization headers) + per-call HMAC token. 20ms-paced
  playout queue on the Asterisk-write side (fixes bot burst-delivery crackle).
- `src/agent/lib/voice-call.ts`: `'sip'` provider + `placeSipLiveCall` (JSON POST to the gateway;
  passes id/exp/t/purpose/recipientName/voice/callType; row provider 'sip', callSid = ARI channel).
- `worker/scripts/gemini-live-bot.mjs`: reads `ctrl` from the start frame → transport='sip' →
  DELETE-hangup / PUT-transfer target the gateway, not NGS. Backward-compatible (NGS/Twilio unchanged).
- Asterisk side (VPS, applied + backed up): http.conf `enabled=yes` :8088 (localhost), ari.conf user
  `alma`. Documented in `worker/deploy/asterisk/alma-sip-gateway.conf`.
- VPS env (worker .env, secrets never in git): SIP_GATEWAY_PORT/KEY/SECRET, ARI_BASE/USER/PASS/APP,
  SIP_TRUNK_ENDPOINT=alma, AUDIOSOCKET_BIND/PORT/ADVERTISE_HOST, SIP_BOT_WS_URL, SIP_GATEWAY_CTRL_BASE.
- PROVEN: originate → answer → Stasis bridge + AudioSocket → two-way Bangla AI (in=656/out=216 chunks)
  → clean control-API DELETE hangup. Reverse-path STT rendered clean Bangla.
- DEFERRED POLISH (owner heard, said fix later): residual audio crackle to re-judge after the paced
  playout; STT occasionally mis-transcribed to Hindi on unclear speech. See memory
  project_sip_phase1_audio_polish. To FLIP prod: set VOICE_CALL_PROVIDER=sip + SIP_GATEWAY_* on Vercel
  (relay stays the one-env-var fallback). Gateway control API :8770 hardening = Phase 3.

### Original plan (kept for reference)
- Persist worker/deploy/asterisk/* configs; systemd/pm2-managed; firewall 5060/5062 -> trunk IP.
- NEW worker/src/voice-relay/sip-gateway-service.mjs (pm2): ARI Stasis + AudioSocket bridge
  (slin<->mulaw reusing sarvam-media.mjs muLawToPcm16 + gateway encoder; 20ms; clear->flush)
  + HTTP control API mirroring NGS (POST/DELETE/GET/PUT /api/v1/call[/{id}], X-Authorization
  headers, new SIP_GATEWAY_KEY/SECRET; PUT parses the bot's <Dial> XML).
- MODIFY src/agent/lib/voice-call.ts: add 'sip' provider + placeSipLiveCall (copy of
  placeNgsLiveCall, JSON body; dial 01...@alma; row provider:'sip', callSid=ARI channel).
- MODIFY worker/scripts/gemini-live-bot.mjs: optional ctrl base in start frame for
  DELETE-hangup / PUT-transfer (backward compatible — NGS keeps working).
- Verify: place a call via sip flag while prod default stays ngs -> two-way Bangla AI,
  barge-in, clean hangup, DB row, report. Then flip the flag. Rollback = env var.

## Phase 2 — Inbound + caller-ID  ✅ BUILT + LIVE-PROVEN 2026-07-25 (NGS off during test)
DONE (owner called the DID from his phone; NGS was off so our registration held):
- `[alma-reg]` registration added (in alma-trunk.conf) → `Registered`. Single-binding account,
  so this only holds while NGS is off — inbound stays a CLEAN CUTOVER.
- Inbound dialplan `worker/deploy/asterisk/alma-inbound.conf`: from-alma remembers the dialled
  number (`ALMA_DID`, else the shared handler sees EXTEN='s' and every DID looks identical) →
  `Stasis(alma-sip,inbound,<caller>,<did>)`.
- Gateway `onInboundCall`: reads the REAL caller from `channel.caller.number`, asks the app who
  it is, answers, bridges the same externalMedia/AudioSocket path as outbound. Fail-safe: if the
  app is unreachable it still answers (self-signed token + local OWNER_PHONE_NUMBERS check) —
  a customer call must never drop because Vercel hiccuped. Stray-channel guard added.
- NEW `src/app/api/assistant/voice-call/sip-inbound/route.ts`: JSON port of ngs-inbound with the
  real caller — `isOwnerNumber(caller)` → owner persona + ERP tools + submit_boss_instruction;
  DB row (provider 'sip'); KV `inbound_transfer_mode`; multi-DID persona/forward via `SIP_DID_MAP`.
- Bot: per-call `forwardNumber()` (per-DID forward target) replacing the single env constant.
- PROVEN LIVE: `INBOUND from=+8801779640373 did=…` → `owner=y` → `callType=owner` → the bot
  greeted "বস!" and ran two-way (in=294 chunks / out=88 msgs) → clean hangup. Unknown caller
  self-test → `owner=n` (receptionist). DID capture verified (`did=09649777738`).
- OPEN: the sip-inbound route only takes effect once deployed to prod (until then the gateway
  fallback answers, so there is no DB row/report for inbound). STT language drift persists
  (transcript rendered Hindi/Italian while the model still understood + replied in Bangla) —
  transcript/summary quality only; batched with the deferred audio polish.

### Original plan (kept for reference)
- Add [alma-reg] registration (block in alma-trunk.conf) — takes the binding; NGS trunk must
  be disabled at cutover (owner sets NGS port wrong / disables trunk).
- from-alma dialplan -> AudioSocket -> bot, passing caller-ID (From) + callType.
- NEW src/app/api/assistant/voice-call/sip-inbound/route.ts — port of ngs-inbound returning
  JSON params; reuses isOwnerNumber(caller) (finally a REAL number), personas, transferMode,
  row creation. Owner-recognition proven-possible.
- Multi-DID (owner ask): each DID its own from-alma-<n> context -> boss line = owner AI, a
  2nd DID = staff/support forward. Needs a 2nd DID from the provider. Asterisk does this
  trivially (NGS single-forward limit gone).
- Verify: owner calls the DID -> greeted as Boss; unknown number -> receptionist + transfer.

## Phase 3 — Parity + retire NGS  ✅ BUILT 2026-07-25 (code complete; NGS retirement = owner's call)
DONE:
- **Per-call CDR in the gateway** — once a channel ends, ARI can say nothing about it, so the
  outcome sweep could never explain a failed call. The gateway now keeps a bounded ring
  (SIP_CDR_MAX, default 500) with the ISDN hangup cause, and `GET /api/v1/call/{id}` serves the
  live channel state first, then the CDR. PROVEN: an unroutable number returned
  `status:"no_answer", cause:19 "User alerting, no answer"`.
- **Provider-aware outcome reporting** — `reportNgsCallOutcome` dispatches SIP rows to a new
  `reportSipCallOutcome` (asks OUR gateway, maps busy/no_answer/failed, honours the 90s
  report_pending grace, and after 10 min closes a row the gateway has no memory of rather than
  leaving it 'ringing' forever — without inventing an outcome). Sweep cron now includes
  `provider: 'sip'`.
- **One-way message calls** — `makeSipCall()` in worker/src/notify/twilio-call.mjs: same TTS →
  8 kHz WAV → Supabase signed URL pipeline, but the gateway originates via ARI, plays the file
  (`playUrl` on POST /api/v1/call; ARI can't play HTTP, so the gateway stages it to disk and
  plays `sound:/path`) and hangs up on PlaybackFinished. No bot = no Gemini spend on an alert.
  `ONE_WAY_CALL_PROVIDER=sip`, Twilio remains the automatic fallback; salah stays on Twilio.
- **Concurrency cap** — SIP_MAX_CONCURRENT_CALLS (default 4): a runaway loop or stolen control
  key cannot dial a fleet of PSTN legs. Returns 429.
- **SIP port hardening** — `worker/deploy/asterisk/sip-firewall.sh`, APPLIED + VERIFIED LIVE.
  Measured before: 281 scanner packets in 20s from one host; after: the flood stops at the
  kernel. Surgical (UDP 5060/5062 only — SSH, worker ports and the RTP range untouched), and
  re-registration through the firewall was verified immediately (`Registered`). Rules are NOT
  reboot-persistent by design: that fails OPEN, so it can never cause an outage.
- VERIFICATION STATUS: CDR + cap + auth + firewall + registration all proven live. One-way
  playback proven as far as possible without an answered call — Asterisk converted our WAV
  cleanly (`file convert` → ulaw, 8.7s), so format/path are correct; the owner did not pick up
  the two test calls, so **live one-way audio is still owner-pending**.

### Retirement checklist (do NOT rush — owner decision)
1. Flip `VOICE_CALL_PROVIDER=sip` (+ SIP_GATEWAY_*) and `ONE_WAY_CALL_PROVIDER=sip` on Vercel.
2. Deploy the sip-inbound route to prod (inbound DB rows/reports need it; until then the
   gateway's fail-safe persona answers).
3. Run 2–4 weeks with NGS off but still subscribed (instant rollback = one env var).
4. Only then drop the NGS_* env vars and cancel the subscription.

### Original plan (kept for reference)
- ngs-call-outcome.ts + ngs-call-sweep cron accept provider sip (GET gateway state).
- worker/src/notify/twilio-call.mjs one-way <Play> -> ARI channels/{id}/play.
- Security hardening, MAX_CONCURRENT cap, per-call CDR. After 2-4 weeks clean: drop ~12
  NGS_* env vars, stop the NGS subscription.

## Out of scope / unchanged
WhatsApp call leg stays on Twilio. Bot personas/tools/report path/agent_voice_calls schema
reused. The bot's WS frame contract is the ONLY seam.

# PHONE-AGENT FEATURES built this session — PENDING VERIFICATION (catch up at the end,
# whichever transport is active). SHIPPED to main but NOT owner-verified live / had bugs:
- Owner inbound recognition (human-PA #1) — BROKEN on NGS (no caller-ID); self-host FIXES it
  (proven). Verify "জি বস" on a real inbound call post-cutover.
- Business call place_business_call (#2) — NOT verified; earlier one-way audio on NGS. Retest.
- Unanswered-call retry x2 + WhatsApp-text fallback (#3) — unit-tested only; verify live.
- Recurring report calls (#4) — recurrence chain PROVEN (stale-path rebook). OK.
- Prior-call continuity (#5) — NOT verified live.
- Unknown-inbound-caller save suggestion (#6) — NOT verified live.
- Transfer ask_first mode (#7) — NOT verified live.
- Salah-aware ladder (#8) — unit-tested only.
- Contact-list role-aware persona — seeded (Boss+Eyafi+Mustahid); staff-persona NOT verified.
- ALMA->আলমা pronunciation fix — deployed on the bot; verify on a live call.
- PA-4 native badge — branch native/pa4-voice-badge, UNCOMPILED; sim-verify + one batched
  TestFlight (doc: docs/PA4_NATIVE_HANDOFF.md).
- Diagnostic branches to clean: ngs-caller-var-probe, inbound-caller-*, ngs-caller-diag
  (temporary, not merged/deployed).
- Separate spawned tasks: quiet-hours Dhaka-hour drift; claim-verifier tool-less-claim gap.

## Verification protocol (owner rule)
Every phase ends with a LIVE call test (owner's phone) + DB row + report check, provider flag
/ NGS fallback one env-var away. Deploys: Vercel (routes) + MANUAL worker deploy
(gh workflow run deploy-worker.yml) + VPS Asterisk config. NGS stays until 100%.
